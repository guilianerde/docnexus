import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { getManagedRecord, upsertManagedDocument } from "../src/managed-documents.js";
import { initializeProject } from "../src/project.js";
import { resetProjectData } from "../src/reset.js";
import { SKILL_NAMES } from "../src/skills.js";

const execute = promisify(execFile);
const roots: string[] = [];
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "docnexus-git-"));
  roots.push(root);
  return root;
}
async function git(root: string, ...args: string[]) {
  return (await execute("git", ["-C", root, ...args])).stdout.trim();
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it("keeps default initialization independent of Git, including when Git is unavailable", async () => {
  const root = await makeRoot();
  vi.stubEnv("PATH", "");
  const result = JSON.parse(await runCli(["init"], root));
  expect(result).not.toHaveProperty("git");
  await expect(access(join(root, "docnexus", ".git"))).rejects.toThrow();
  await expect(access(join(root, ".gitignore"))).rejects.toThrow();
});

it("opts into a separate origin without changing the host remote or staging files", async () => {
  const root = await makeRoot();
  await git(root, "init");
  await git(root, "remote", "add", "origin", "https://example.com/business.git");
  await writeFile(join(root, ".gitignore"), "build/\n");
  const result = JSON.parse(await runCli(["init", "--git-remote", "git@example.com:team/knowledge.git"], root));
  const workspace = join(root, "docnexus");
  expect(result.git).toMatchObject({ remote: "git@example.com:team/knowledge.git", repository: workspace });
  expect(await git(workspace, "remote", "get-url", "origin")).toBe("git@example.com:team/knowledge.git");
  expect(await git(root, "remote", "get-url", "origin")).toBe("https://example.com/business.git");
  expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("build/\n/docnexus/\n");
  expect(await git(root, "check-ignore", "docnexus/library/test.md")).toBe("docnexus/library/test.md");
  expect(await git(workspace, "ls-files")).toBe("");
  for (const path of ["node_modules/test", "store/test", ".runtime/test"]) {
    expect(await git(root, "check-ignore", `.docnexus/${path}`)).toBe(`.docnexus/${path}`);
  }
});

it("configures an existing workspace, updates its remote explicitly and leaves it alone on ordinary init", async () => {
  const root = await makeRoot();
  await initializeProject(root);
  const file = join(root, "docnexus", "library", "keep.md");
  await writeFile(file, "knowledge sentinel");
  await initializeProject(root, { gitRemote: "https://example.com/first.git" });
  await initializeProject(root, { gitRemote: "https://example.com/second.git" });
  const workspace = join(root, "docnexus");
  expect(await git(workspace, "remote", "get-url", "origin")).toBe("https://example.com/second.git");
  await expect(initializeProject(root)).resolves.toMatchObject({ created: false });
  expect(await readFile(file, "utf8")).toBe("knowledge sentinel");
  expect(await git(workspace, "remote", "get-url", "origin")).toBe("https://example.com/second.git");
});

it("keeps bundled assets local in a host repository while tracking knowledge, versions and custom skills", async () => {
  const root = await makeRoot();
  await git(root, "init");
  await initializeProject(root);
  const workspace = join(root, "docnexus");
  const internal = join(root, ".docnexus");
  // Simulate an existing workspace whose skills already match the installed version.
  await writeFile(join(internal, ".gitignore"), "node_modules/\nstore/\n.runtime/\n");
  await mkdir(join(internal, "skills", "docnexus-custom"));
  await writeFile(join(internal, "skills", "docnexus-custom", "SKILL.md"), "Project-owned workflow");
  await writeFile(join(internal, "schemas", "custom.json"), "{}");
  await writeFile(join(internal, "package.json"), JSON.stringify({ dependencies: { "@rowansenne/docnexus": "0.22.0" } }));
  await writeFile(join(internal, "package-lock.json"), "version lock sentinel");
  await mkdir(join(workspace, "impacts"));
  await writeFile(join(workspace, "impacts", "keep.json"), "{}");
  const saved = await upsertManagedDocument(root, { file_path: "keep.md", source: "Original source", document: "# Keep knowledge",
    metadata: { title: "Keep", summary: "Knowledge sentinel", tags: [], entities: [], relationships: [] } });

  await runCli(["document", "list"], root);
  const ignore = await readFile(join(internal, ".gitignore"), "utf8");
  await runCli(["skills", "sync"], root);
  expect(await readFile(join(internal, ".gitignore"), "utf8")).toBe(ignore);
  for (const path of [...SKILL_NAMES.map(name => `skills/${name}/SKILL.md`), "skills/.docnexus-skills.json", "schemas/metadata.schema.json"]) {
    expect(await git(root, "check-ignore", `.docnexus/${path}`)).toBe(`.docnexus/${path}`);
  }
  await git(root, "add", ".");
  const tracked = (await git(root, "ls-files")).split("\n");
  for (const path of ["library/keep.md", "impacts/keep.json",
    ...["source.md", "metadata.json", "timeline.md", "record.json"].map(name => `records/${saved.id}/${name}`)]) {
    expect(tracked).toContain(`docnexus/${path}`);
  }
  for (const path of ["project.json", "package.json", "package-lock.json", "skills/docnexus-custom/SKILL.md", "schemas/custom.json"]) {
    expect(tracked).toContain(`.docnexus/${path}`);
  }
  expect(tracked.some(path => SKILL_NAMES.some(name => path.startsWith(`.docnexus/skills/${name}/`)))).toBe(false);
  expect(tracked).not.toContain(".docnexus/schemas/metadata.schema.json");
});

it("adds ignore rules without untracking previously committed package assets", async () => {
  const root = await makeRoot();
  await git(root, "init");
  await initializeProject(root);
  await writeFile(join(root, ".docnexus", ".gitignore"), "node_modules/\nstore/\n.runtime/\n");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Existing workspace");
  const index = await git(root, "ls-files", "--stage");
  expect(index).toContain(".docnexus/skills/docnexus/SKILL.md");
  expect(index).toContain(".docnexus/schemas/metadata.schema.json");
  await initializeProject(root);
  await runCli(["skills", "sync"], root);
  expect(await git(root, "ls-files", "--stage")).toBe(index);
  expect(await git(root, "diff", "--cached")).toBe("");
});

it("pins a newly configured knowledge repository to main independently of Git defaults", async () => {
  const root = await makeRoot();
  const result = await initializeProject(root, { gitRemote: "https://example.com/knowledge.git" });
  const workspace = join(root, "docnexus");
  expect(result.git).toMatchObject({ branch: "main" });
  expect(await git(workspace, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(JSON.parse(await readFile(join(workspace, ".git", "docnexus-branch.json"), "utf8"))).toEqual({ format_version: 1, branch: "main" });
});

it("blocks recovery, CLI writes, reset and reconfiguration after a branch switch and resumes on main", async () => {
  const root = await makeRoot();
  await initializeProject(root, { gitRemote: "https://example.com/knowledge.git" });
  const workspace = join(root, "docnexus");
  await mkdir(join(root, ".docnexus", ".runtime"));
  const journal = join(root, ".docnexus", ".runtime", "transaction.json");
  await writeFile(journal, JSON.stringify({ version: 1, phase: "apply", entries: [{ path: "docnexus/library/recovery-probe.md", before: null, after: "Recovery probe" }],
    remove_directories: [], rollback_directories: [] }));
  await git(workspace, "switch", "--orphan", "other");
  const marker = await readFile(join(root, ".docnexus", "project.json"), "utf8");
  await expect(runCli(["draft", "new"], root)).rejects.toMatchObject({ code: "git_branch_mismatch", details: { allowed_branch: "main", actual_branch: "other" } });
  await expect(resetProjectData(root, { force: true })).rejects.toMatchObject({ code: "git_branch_mismatch" });
  await expect(initializeProject(root, { gitRemote: "https://example.com/other.git" })).rejects.toMatchObject({ code: "git_branch_mismatch" });
  expect(await readFile(join(root, ".docnexus", "project.json"), "utf8")).toBe(marker);
  await expect(access(join(workspace, "library", "recovery-probe.md"))).rejects.toThrow();
  await expect(access(journal)).resolves.toBeUndefined();
  expect(await git(workspace, "remote", "get-url", "origin")).toBe("https://example.com/knowledge.git");
  await git(workspace, "symbolic-ref", "HEAD", "refs/heads/main");
  await expect(runCli(["draft", "new"], root)).resolves.toContain("draft_id");
  expect(await readFile(join(workspace, "library", "recovery-probe.md"), "utf8")).toBe("Recovery probe");
  await expect(access(journal)).rejects.toThrow();
});

it("keeps an existing single branch without renaming it and refuses additional local branches or detached HEAD", async () => {
  const root = await makeRoot();
  await initializeProject(root);
  const workspace = join(root, "docnexus");
  await git(workspace, "init", "--initial-branch=knowledge");
  await git(workspace, "add", ".");
  await git(workspace, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Knowledge");
  const result = await initializeProject(root, { gitRemote: "https://example.com/knowledge.git" });
  expect(result.git).toMatchObject({ branch: "knowledge" });
  await git(workspace, "branch", "extra");
  await expect(runCli(["document", "list"], root)).rejects.toMatchObject({ code: "git_branch_mismatch" });
  expect(await git(workspace, "branch", "--list", "extra")).toContain("extra");
  await git(workspace, "branch", "-d", "extra");
  await git(workspace, "checkout", "--detach");
  await expect(runCli(["document", "list"], root)).rejects.toMatchObject({ code: "git_branch_mismatch", details: { actual_branch: null } });
  await git(workspace, "switch", "knowledge");
  await expect(runCli(["document", "list"], root)).resolves.toContain("records");
});

it("refuses to pin a repository with multiple branches without changing them or its origin", async () => {
  const root = await makeRoot();
  await initializeProject(root);
  const workspace = join(root, "docnexus");
  await git(workspace, "init", "--initial-branch=main");
  await git(workspace, "add", ".");
  await git(workspace, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Knowledge");
  await git(workspace, "branch", "extra");
  await git(workspace, "remote", "add", "origin", "https://example.com/original.git");
  await expect(initializeProject(root, { gitRemote: "https://example.com/new.git" })).rejects.toMatchObject({ code: "git_branch_mismatch" });
  expect(await git(workspace, "remote", "get-url", "origin")).toBe("https://example.com/original.git");
  expect(await git(workspace, "branch", "--list", "extra")).toContain("extra");
});

it("preserves branch policy through reset and rejects use without Git instead of skipping the guard", async () => {
  const root = await makeRoot();
  await initializeProject(root, { gitRemote: "https://example.com/knowledge.git" });
  const pin = join(root, "docnexus", ".git", "docnexus-branch.json");
  const before = await readFile(pin, "utf8");
  await resetProjectData(root, { force: true });
  await initializeProject(root);
  expect(await readFile(pin, "utf8")).toBe(before);
  vi.stubEnv("PATH", "");
  await expect(runCli(["document", "list"], root)).rejects.toMatchObject({ code: "git_unavailable" });
});

it("refuses host-tracked knowledge before creating a nested repository or changing ignores", async () => {
  const root = await makeRoot();
  await git(root, "init");
  await initializeProject(root);
  await git(root, "add", "docnexus/CONCEPTS.md");
  const index = await git(root, "ls-files", "--stage");
  await expect(initializeProject(root, { gitRemote: "https://example.com/knowledge.git" })).rejects.toMatchObject({ code: "git_operation_failed" });
  expect(await git(root, "ls-files", "--stage")).toBe(index);
  await expect(access(join(root, "docnexus", ".git"))).rejects.toThrow();
  await expect(access(join(root, ".gitignore"))).rejects.toThrow();
});

it("isolates a project nested below the host Git root using its own ignore file", async () => {
  const host = await makeRoot();
  await git(host, "init");
  const root = join(host, "apps", "service");
  await mkdir(root, { recursive: true });
  await initializeProject(root, { gitRemote: "https://example.com/service-memory.git" });
  expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("/docnexus/\n");
  expect(await git(host, "check-ignore", "apps/service/docnexus/project.json")).toBe("apps/service/docnexus/project.json");
});

it("keeps host exclusion effective after prior negations and idempotent on repeated setup", async () => {
  const root = await makeRoot();
  await git(root, "init");
  await writeFile(join(root, ".gitignore"), "/docnexus/\n!/docnexus/\n");
  await initializeProject(root, { gitRemote: "https://example.com/knowledge.git" });
  const ignore = await readFile(join(root, ".gitignore"), "utf8");
  expect(await git(root, "check-ignore", "docnexus/project.json")).toBe("docnexus/project.json");
  await initializeProject(root, { gitRemote: "https://example.com/knowledge.git" });
  expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(ignore);
});

it("does not let inherited Git routing redirect setup into another repository", async () => {
  const root = await makeRoot();
  const other = await makeRoot();
  await git(other, "init");
  await git(other, "remote", "add", "origin", "https://example.com/other.git");
  vi.stubEnv("GIT_DIR", join(other, ".git"));
  vi.stubEnv("GIT_WORK_TREE", other);
  await initializeProject(root, { gitRemote: "https://example.com/knowledge.git" });
  vi.unstubAllEnvs();
  expect(await git(other, "remote", "get-url", "origin")).toBe("https://example.com/other.git");
  expect(await git(join(root, "docnexus"), "remote", "get-url", "origin")).toBe("https://example.com/knowledge.git");
});

it("reads committed knowledge after a manual push and clone into a second project", async () => {
  const remote = await makeRoot();
  await git(remote, "init", "--bare");
  const first = await makeRoot();
  await initializeProject(first, { gitRemote: remote });
  const saved = await upsertManagedDocument(first, { file_path: "shared.md", source: "Team decision", document: "# Shared knowledge\nUse the team convention.",
    metadata: { title: "Shared", summary: "Team convention", tags: [], entities: [], relationships: [] } });
  const workspace = join(first, "docnexus");
  await git(workspace, "add", ".");
  await git(workspace, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Share knowledge");
  await git(workspace, "push", "origin", "HEAD:main");
  const second = await makeRoot();
  await git(second, "clone", "--branch", "main", remote, "docnexus");
  await expect(access(join(second, ".docnexus", "skills"))).rejects.toThrow();
  await expect(access(join(second, ".docnexus", "schemas"))).rejects.toThrow();
  // The installation/configuration directory is backed up separately from knowledge-only Git.
  await mkdir(join(second, ".docnexus"));
  await writeFile(join(second, ".docnexus", "project.json"), await readFile(join(first, ".docnexus", "project.json")));
  await expect(runCli(["document", "list"], second)).resolves.toContain(saved.id);
  await expect(readFile(join(second, ".docnexus", "skills", "docnexus", "SKILL.md"), "utf8")).resolves.toContain("name: docnexus");
  await expect(readFile(join(second, ".docnexus", "schemas", "metadata.schema.json"), "utf8")).resolves.toContain("facts");
  await expect(initializeProject(second, { gitRemote: remote, agents: ["codex"] })).resolves.toMatchObject({ created: false });
  await expect(readFile(join(second, ".agents", "skills", "docnexus", "SKILL.md"), "utf8")).resolves.toContain("name: docnexus");
  expect(await git(join(second, "docnexus"), "status", "--porcelain")).toBe("");
  const record = await getManagedRecord(second, saved.id);
  expect(record.document).toContain("Use the team convention.");
  expect(record.source).toBe("Team decision");
});

it("preserves Git history and origin through reset and reinitialization", async () => {
  const root = await makeRoot();
  await initializeProject(root, { gitRemote: "https://example.com/knowledge.git" });
  const workspace = join(root, "docnexus");
  await git(workspace, "add", ".");
  await git(workspace, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial knowledge");
  const head = await git(workspace, "rev-parse", "HEAD");
  const result = await resetProjectData(root, { force: true });
  expect(result).toMatchObject({ preserved_git: true });
  expect(await git(workspace, "rev-parse", "HEAD")).toBe(head);
  expect(await git(workspace, "remote", "get-url", "origin")).toBe("https://example.com/knowledge.git");
  await expect(access(join(root, ".docnexus", "project.json"))).rejects.toThrow();
  await expect(initializeProject(root)).resolves.toMatchObject({ created: true });
  expect(await git(workspace, "rev-parse", "HEAD")).toBe(head);
});

it("initializes an empty Git repository but does not adopt unrelated content", async () => {
  const root = await makeRoot();
  const workspace = join(root, "docnexus");
  await mkdir(workspace);
  await git(workspace, "init");
  await expect(initializeProject(root)).resolves.toMatchObject({ created: true });
  await resetProjectData(root, { force: true });
  await writeFile(join(workspace, "notes.md"), "unrelated");
  await expect(initializeProject(root)).rejects.toThrow("is not a DocNexus workspace");
  expect(await readFile(join(workspace, "notes.md"), "utf8")).toBe("unrelated");
});

it("fails optional setup before writing when Git is unavailable or the remote is invalid", async () => {
  const root = await makeRoot();
  for (const remote of ["", " --upload-pack=bad", "https://example.com/a.git\nother"]) {
    await expect(initializeProject(root, { gitRemote: remote })).rejects.toMatchObject({ code: "invalid_params" });
  }
  vi.stubEnv("PATH", "");
  await expect(initializeProject(root, { gitRemote: "https://example.com/knowledge.git" })).rejects.toMatchObject({ code: "git_unavailable" });
  await expect(access(join(root, "docnexus"))).rejects.toThrow();
});

it("rejects symbolic links in workspace Git metadata or the host ignore file", async () => {
  const root = await makeRoot();
  const elsewhere = await makeRoot();
  await initializeProject(root);
  await git(elsewhere, "init");
  await symlink(join(elsewhere, ".git"), join(root, "docnexus", ".git"), "dir");
  await expect(initializeProject(root, { gitRemote: "https://example.com/knowledge.git" })).rejects.toThrow("symbolic links");
  await rm(join(root, "docnexus", ".git"));
  await git(root, "init");
  const sentinel = join(elsewhere, "ignore");
  await writeFile(sentinel, "keep");
  await symlink(sentinel, join(root, ".gitignore"));
  await expect(initializeProject(root, { gitRemote: "https://example.com/knowledge.git" })).rejects.toThrow("symbolic links");
  expect(await readFile(sentinel, "utf8")).toBe("keep");
  await expect(access(join(root, "docnexus", ".git"))).rejects.toThrow();
});

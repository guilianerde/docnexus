import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { initializeProject, projectMarkerPath } from "../src/project.js";
import { resetProjectData } from "../src/reset.js";

const roots: string[] = [];
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "docnexus-output-"));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("persists custom knowledge paths through capture, search, recall, navigation, impacts and reset", async () => {
  const root = await makeRoot();
  const parent = "docs/知识库";
  const output = `${parent}/docnexus`;
  await writeFile(join(root, "keep.md"), "Unrelated project file");
  await mkdir(join(root, parent), { recursive: true });
  await writeFile(join(root, parent, "keep.md"), "Parent directory sentinel");
  const initialized = JSON.parse(await runCli(["init", "--output-dir", parent, "--agent", "all"], root));
  expect(initialized).toMatchObject({ workspace: join(root, output), internal_directory: join(root, ".docnexus") });
  expect(JSON.parse(await readFile(projectMarkerPath(root), "utf8"))).toMatchObject({ format_version: 7, output_dir: parent });
  expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toContain(`@${output}/CONCEPTS.md`);
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain(`${output}/concepts/`);
  expect(await readlink(join(root, ".agents", "skills", "docnexus"))).toBe(process.platform === "win32" ? join(root, ".docnexus", "skills", "docnexus") : join("..", "..", ".docnexus", "skills", "docnexus"));

  const draft = JSON.parse(await runCli(["draft", "new", "--slug", "routing"], root));
  expect(draft.draft_directory).toMatch(/^\.docnexus\/drafts\//);
  const metadata = { title: "Output routing", summary: "Persist configurable output routing", category: "工具", tags: [],
    entities: [{ name: "Output routing", type: "component", description: "Configurable knowledge location" }], relationships: [] };
  await writeFile(join(root, draft.artifacts.source), "Users choose the knowledge directory.");
  await writeFile(join(root, draft.artifacts.document), "# Output routing\nKnowledge lives in the configured directory.");
  await writeFile(join(root, draft.artifacts.metadata), JSON.stringify(metadata));
  await runCli(["draft", "seal", "--id", draft.draft_id, "--file", "routing.md"], root);
  const saved = JSON.parse(await runCli(["document", "add", "--draft", draft.draft_id], root));
  expect(saved.library_path).toBe(`${output}/library/routing.md`);
  expect(saved.timeline_path).toBe(`${output}/records/${saved.id}/timeline.md`);
  await expect(stat(join(root, saved.timeline_path))).resolves.toBeDefined();
  await expect(stat(join(root, ".docnexus", "schemas", "metadata.schema.json"))).resolves.toBeDefined();
  const queried = JSON.parse(await runCli(["document", "query", "--all"], root));
  expect(queried.documents[0].library_path).toBe(saved.library_path);
  const found = JSON.parse(await runCli(["search", "Output routing"], root));
  expect(found.results[0].library_path).toBe(saved.library_path);
  expect(await runCli(["concepts", "--format", "md"], root)).toContain(saved.library_path);
  expect(await readFile(join(root, output, "CONCEPTS.md"), "utf8")).toContain(`${output}/concepts/`);
  expect(await readFile(join(root, output, "concepts", "工具.md"), "utf8")).toContain(saved.library_path);
  const record = JSON.parse(await runCli(["document", "get", "--id", saved.id], root));
  await writeFile(join(root, "impact-input.json"), JSON.stringify({ source: { id: saved.id, record_version: record.record_version },
    scope: "Checked routing references", limitations: "", pages: [] }));
  const impact = JSON.parse(await runCli(["impact", "save", "--file", "impact-input.json"], root));
  expect(impact.impact_path).toMatch(new RegExp(`^${output}/impacts/impact_`));
  expect(await runCli(["impact", "get", "--id", impact.id], root)).toContain(impact.impact_path);
  await runCli(["recall", "Output routing"], root);
  await expect(stat(join(root, ".docnexus", "store", "brain.pglite"))).resolves.toBeDefined();
  await expect(lstat(join(root, output, "store"))).rejects.toThrow();
  await expect(lstat(join(root, "docnexus"))).rejects.toThrow();
  expect(JSON.parse(await runCli(["status"], root)).workspace_path).toBe(join(root, output));
  await expect(initializeProject(root)).resolves.toMatchObject({ created: false, workspace: join(root, output) });
  await expect(initializeProject(root, { outputDir: "elsewhere" })).rejects.toThrow("cannot change");
  expect(JSON.parse(await readFile(projectMarkerPath(root), "utf8")).output_dir).toBe(parent);
  await resetProjectData(root, { force: true });
  await expect(stat(join(root, output))).rejects.toThrow();
  await expect(stat(join(root, ".docnexus"))).rejects.toThrow();
  expect(await readFile(join(root, "keep.md"), "utf8")).toBe("Unrelated project file");
  expect(await readFile(join(root, parent, "keep.md"), "utf8")).toBe("Parent directory sentinel");
});

it("recovers interrupted writes using the persisted custom output directory", async () => {
  const root = await makeRoot();
  await initializeProject(root, { outputDir: "knowledge" });
  await mkdir(join(root, ".docnexus", ".runtime"));
  await writeFile(join(root, ".docnexus", ".runtime", "transaction.json"), JSON.stringify({ version: 1, phase: "apply",
    entries: [{ path: "knowledge/docnexus/library/recovered.md", before: null, after: "Recovered" }], remove_directories: [], rollback_directories: [] }));
  await runCli(["document", "list"], root);
  expect(await readFile(join(root, "knowledge", "docnexus", "library", "recovered.md"), "utf8")).toBe("Recovered");
});

it.each(["..", "../outside", "/tmp/outside", ".docnexus", ".docnexus/library", ".git/data", ".agents/data", ".claude/data", "node_modules/data", "bad\npath"])("rejects unsafe output directory %j before initializing", async outputDir => {
  const root = await makeRoot();
  await expect(initializeProject(root, { outputDir })).rejects.toMatchObject({ code: "invalid_params" });
  await expect(stat(projectMarkerPath(root))).rejects.toThrow();
});

it("rejects symbolic output paths and legacy workspaces without modifying them", async () => {
  const root = await makeRoot();
  const external = await makeRoot();
  await symlink(external, join(root, "linked"), "dir");
  await expect(initializeProject(root, { outputDir: "linked/knowledge" })).rejects.toThrow("symbolic links");
  await mkdir(join(root, "docnexus"));
  const legacy = JSON.stringify({ format_version: 6, initialized_at: "old" });
  await writeFile(join(root, "docnexus", "project.json"), legacy);
  await expect(initializeProject(root)).rejects.toMatchObject({ code: "unsupported_format" });
  expect(await readFile(join(root, "docnexus", "project.json"), "utf8")).toBe(legacy);
  await expect(stat(projectMarkerPath(root))).rejects.toThrow();
});

it("sets up and enforces the Git branch guard in a custom output directory", async () => {
  const root = await makeRoot();
  const execute = promisify(execFile);
  await execute("git", ["-C", root, "init"]);
  const result = await initializeProject(root, { outputDir: "docs/memory", gitRemote: "https://example.com/memory.git" });
  expect(result.git?.repository).toBe(join(root, "docs/memory/docnexus"));
  expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("/docs/memory/docnexus/\n");
  await execute("git", ["-C", join(root, "docs/memory/docnexus"), "switch", "--orphan", "other"]);
  await expect(runCli(["document", "list"], root)).rejects.toMatchObject({ code: "git_branch_mismatch" });
});

it("refuses host-tracked custom output before writing project configuration", async () => {
  const root = await makeRoot();
  const execute = promisify(execFile);
  await execute("git", ["-C", root, "init"]);
  await mkdir(join(root, "docs/memory/docnexus"), { recursive: true });
  await writeFile(join(root, "docs/memory/docnexus/keep.md"), "Tracked knowledge");
  await execute("git", ["-C", root, "add", "docs/memory/docnexus/keep.md"]);
  await expect(initializeProject(root, { outputDir: "docs/memory", gitRemote: "https://example.com/memory.git" })).rejects.toMatchObject({ code: "git_operation_failed" });
  await expect(stat(projectMarkerPath(root))).rejects.toThrow();
  await expect(stat(join(root, "docs/memory/docnexus/.git"))).rejects.toThrow();
});

it("refuses reset when a configured output ancestor becomes a symbolic link", async () => {
  const root = await makeRoot();
  const external = await makeRoot();
  await initializeProject(root, { outputDir: "docs/memory" });
  await rm(join(root, "docs"), { recursive: true });
  await mkdir(join(external, "memory"));
  await writeFile(join(external, "memory/keep.md"), "External sentinel");
  await symlink(external, join(root, "docs"), "dir");
  await expect(resetProjectData(root, { force: true })).rejects.toThrow("symbolic links");
  expect(await readFile(join(external, "memory/keep.md"), "utf8")).toBe("External sentinel");
});

it("uses project/docnexus for the default parent and explicit dot without adding another layer", async () => {
  const root = await makeRoot();
  expect(await initializeProject(root)).toMatchObject({ workspace: join(root, "docnexus"), created: true });
  expect(JSON.parse(await readFile(projectMarkerPath(root), "utf8")).output_dir).toBe(".");
  expect(await initializeProject(root, { outputDir: "." })).toMatchObject({ workspace: join(root, "docnexus"), created: false });
  await expect(stat(join(root, "docnexus/docnexus"))).rejects.toThrow();
});

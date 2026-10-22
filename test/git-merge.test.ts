import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { writeConceptIndex } from "../src/concepts.js";
import { factDocumentTemplate } from "../src/fact-renderer.js";
import { manageGitHooks, runGitHook } from "../src/git-hooks.js";
import { sha256, stableJson } from "../src/hash.js";
import { upsertManagedDocument } from "../src/managed-documents.js";
import { initializeProject } from "../src/project.js";

const execute = promisify(execFile);
const roots: string[] = [];

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "docnexus-merge-"));
  roots.push(root);
  return root;
}
async function git(root: string, ...args: string[]) {
  return (await execute("git", ["-C", root, ...args])).stdout;
}
/** Runs a Git command that is expected to fail (conflicting merge) and reports whether it did. */
async function gitFailed(root: string, ...args: string[]) {
  try { await execute("git", ["-C", root, ...args]); return false; } catch { return true; }
}
async function gitShow(root: string, spec: string) {
  return (await execute("git", ["-C", root, "show", spec])).stdout;
}
async function stage(root: string, ...paths: string[]) {
  await git(root, "add", ...paths);
}

const metadata = { title: "Token rotation", summary: "Refresh token policy", tags: ["auth"], entities: [], relationships: [] };
const input = { file_path: "auth/rotation.md", source: "Initial source.", document: "# Token rotation\n\nInitial body.", metadata };

async function initRepo(root: string): Promise<string> {
  await git(root, "init");
  await git(root, "config", "user.email", "merge-test@example.com");
  await git(root, "config", "user.name", "Merge Test");
  await initializeProject(root);
  const first = await upsertManagedDocument(root, input);
  await writeConceptIndex(root);
  await stage(root, "docnexus", ".docnexus/project.json");
  await git(root, "commit", "-m", "initial");
  await git(root, "branch", "-M", "main");
  return first.id;
}

/** Two commits changing one document on both sides, then a conflicting `git merge`. */
async function conflictingRepo(options: { business?: boolean } = {}) {
  const root = await makeRoot();
  const id = await initRepo(root);
  if (options.business) {
    await writeFile(join(root, "notes.txt"), "base\n");
    await stage(root, "notes.txt");
    await git(root, "commit", "-m", "notes base");
  }
  await git(root, "checkout", "-b", "feature");
  await upsertManagedDocument(root, { ...input, source: "Theirs source.", document: "# Token rotation\n\nTheirs body.", metadata: { ...metadata, summary: "Theirs summary" } });
  if (options.business) {
    await writeFile(join(root, "notes.txt"), "theirs\n");
    await stage(root, "notes.txt");
  }
  await stage(root, "docnexus");
  await git(root, "commit", "-m", "theirs");
  await git(root, "checkout", "main");
  await upsertManagedDocument(root, { ...input, source: "Ours source.", document: "# Token rotation\n\nOurs body.", metadata: { ...metadata, summary: "Ours summary" } });
  if (options.business) {
    await writeFile(join(root, "notes.txt"), "ours\n");
    await stage(root, "notes.txt");
  }
  await stage(root, "docnexus");
  await git(root, "commit", "-m", "ours");
  const ours = (await git(root, "rev-parse", "HEAD")).trim();
  const theirs = (await git(root, "rev-parse", "feature")).trim();
  expect(await gitFailed(root, "merge", "--no-edit", "feature")).toBe(true);
  return { root, id, ours, theirs };
}

/** Resolves the four authored assets against ours' stages; record.json stays conflicted (generated). */
async function resolveContent(root: string, id: string) {
  const library = "# Token rotation\n\nOurs body.\n\nTheirs body.\n";
  await writeFile(join(root, "docnexus/library/auth/rotation.md"), library);
  for (const asset of ["source.md", "metadata.json", "timeline.md"] as const) {
    await writeFile(join(root, `docnexus/records/${id}/${asset}`), await gitShow(root, `:2:docnexus/records/${id}/${asset}`));
  }
  await stage(root, `docnexus/library/auth/rotation.md`, `docnexus/records/${id}/source.md`, `docnexus/records/${id}/metadata.json`, `docnexus/records/${id}/timeline.md`);
  return library;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it("repairs a conflicted document unit after staging and gates the merge commit", async () => {
  const { root, id, ours, theirs } = await conflictingRepo({ business: true });

  // Capture records both parents and only knowledge paths while the conflict is unresolved.
  expect(await runGitHook(root, "index")).toMatchObject({ status: "waiting" });
  const state = JSON.parse(await readFile(join(root, ".docnexus/.runtime/git-merge.json"), "utf8"));
  expect(state.ours).toBe(ours);
  expect(state.theirs).toBe(theirs);
  const paths: string[] = state.entries.map((entry: { path: string }) => entry.path);
  expect(paths).toContain("docnexus/library/auth/rotation.md");
  expect(paths).toContain(`docnexus/records/${id}/record.json`);
  expect(paths.every(path => path.startsWith("docnexus/"))).toBe(true);

  // Resolving authored content is enough: repair rebuilds record.json and navigation.
  const library = await resolveContent(root, id);
  expect(await runGitHook(root, "index")).toMatchObject({ status: "ready" });
  expect(await git(root, "ls-files", "--unmerged", "--", "docnexus")).toBe("");
  expect(await gitShow(root, ":0:docnexus/library/auth/rotation.md")).toBe(library);
  const record = JSON.parse(await gitShow(root, `:0:docnexus/records/${id}/record.json`));
  const stagedMetadata = JSON.parse(await gitShow(root, `:0:docnexus/records/${id}/metadata.json`));
  expect(record.metadata_hash).toBe(sha256(stableJson(stagedMetadata)));
  expect(record.document_hash).toBe(sha256(factDocumentTemplate(library)));
  expect(record.source_hash).toBe(sha256(await gitShow(root, `:0:docnexus/records/${id}/source.md`)));
  const timeline = await gitShow(root, `:0:docnexus/records/${id}/timeline.md`);
  expect(timeline).toContain("adopted Git merge");
  expect(timeline).toContain(`Git parents: ${ours}, ${theirs}`);
  // Non-knowledge conflicts stay untouched for the user.
  expect(await git(root, "ls-files", "--unmerged", "--", "notes.txt")).not.toBe("");

  // pre-commit gate passes, and a repeated notification does not append a second event.
  expect(await runGitHook(root, "check")).toMatchObject({ status: "verified" });
  expect(await runGitHook(root, "index")).toMatchObject({ status: "ready" });
  expect(await gitShow(root, `:0:docnexus/records/${id}/timeline.md`)).toBe(timeline);

  // The merge concludes once the user resolves the remaining business conflict.
  await writeFile(join(root, "notes.txt"), await gitShow(root, ":3:notes.txt"));
  await stage(root, "notes.txt");
  await git(root, "commit", "--no-edit");
  expect((await git(root, "rev-list", "--parents", "-n", "1", "HEAD")).trim().split(" ")).toHaveLength(3);
});

it("refuses automatic repair that would overwrite unstaged edits", async () => {
  const { root, id } = await conflictingRepo();
  await runGitHook(root, "index");
  await resolveContent(root, id);
  const metadataPath = join(root, `docnexus/records/${id}/metadata.json`);
  await writeFile(metadataPath, `${await readFile(metadataPath, "utf8")}\n`);
  await expect(runGitHook(root, "index")).rejects.toMatchObject({
    code: "git_merge_not_ready",
    message: expect.stringContaining(`unstaged edits in docnexus/records/${id}/metadata.json`)
  });
});

it("refuses same-path documents created independently on both sides", async () => {
  const root = await makeRoot();
  await initRepo(root);
  await git(root, "checkout", "-b", "feature");
  await upsertManagedDocument(root, { file_path: "created.md", source: "Theirs created.", document: "# Created\n\nTheirs side.", metadata: { ...metadata, title: "Created theirs", summary: "Created on feature" } });
  await stage(root, "docnexus");
  await git(root, "commit", "-m", "theirs create");
  await git(root, "checkout", "main");
  await upsertManagedDocument(root, { file_path: "created.md", source: "Ours created.", document: "# Created\n\nOurs side.", metadata: { ...metadata, title: "Created ours", summary: "Created on main" } });
  await stage(root, "docnexus");
  await git(root, "commit", "-m", "ours create");
  expect(await gitFailed(root, "merge", "--no-edit", "feature")).toBe(true);

  expect(await runGitHook(root, "index")).toMatchObject({ status: "waiting" });
  await writeFile(join(root, "docnexus/library/created.md"), "# Created\n\nOurs side.\n\nTheirs side.\n");
  await stage(root, "docnexus/library/created.md");
  await expect(runGitHook(root, "index")).rejects.toMatchObject({
    code: "git_merge_not_ready",
    message: expect.stringContaining("manual recovery")
  });
});

it("refuses modify/delete document conflicts instead of picking a side", async () => {
  const root = await makeRoot();
  const id = await initRepo(root);
  await git(root, "checkout", "-b", "feature");
  await git(root, "rm", "-r", "-q", `docnexus/records/${id}`, "docnexus/library/auth");
  await git(root, "commit", "-m", "theirs delete");
  await git(root, "checkout", "main");
  await upsertManagedDocument(root, { ...input, source: "Modified source.", document: "# Token rotation\n\nModified body.", metadata: { ...metadata, summary: "Modified summary" } });
  await stage(root, "docnexus");
  await git(root, "commit", "-m", "ours modify");
  expect(await gitFailed(root, "merge", "--no-edit", "feature")).toBe(true);

  await runGitHook(root, "index");
  await stage(root, "docnexus");
  await expect(runGitHook(root, "index")).rejects.toMatchObject({
    code: "git_merge_not_ready",
    message: expect.stringContaining("manual recovery")
  });
});

it("validates an adopted knowledge edit from the changed record", async () => {
  const root = await makeRoot();
  await initRepo(root);
  await upsertManagedDocument(root, {
    ...input,
    source: "Updated source.",
    document: "# Token rotation\n\nUpdated body.",
    metadata: { ...metadata, summary: "Updated summary" }
  });
  await stage(root, "docnexus");

  expect(await runGitHook(root, "check")).toMatchObject({ status: "verified", checked_documents: 1 });
});

it("rejects an unadopted library edit with a document sync action", async () => {
  const root = await makeRoot();
  const id = await initRepo(root);
  await writeFile(join(root, "docnexus/library/auth/rotation.md"), "# Token rotation\n\nUnsynced edit.\n");
  await stage(root, "docnexus/library/auth/rotation.md");

  await expect(runGitHook(root, "check")).rejects.toMatchObject({
    code: "text_integrity_error",
    message: expect.stringContaining(`document sync --id ${id}`)
  });
});

it("repairs a library-only conflict by falling back to the record catalog", async () => {
  const root = await makeRoot();
  const id = await initRepo(root);
  const library = join(root, "docnexus/library/auth/rotation.md");
  await git(root, "checkout", "-b", "feature");
  await writeFile(library, "# Token rotation\n\nTheirs hand edit.\n");
  await stage(root, "docnexus/library/auth/rotation.md");
  await git(root, "commit", "-m", "theirs library only");
  await git(root, "checkout", "main");
  await writeFile(library, "# Token rotation\n\nOurs hand edit.\n");
  await stage(root, "docnexus/library/auth/rotation.md");
  await git(root, "commit", "-m", "ours library only");
  expect(await gitFailed(root, "merge", "--no-edit", "feature")).toBe(true);
  expect(await git(root, "ls-files", "--unmerged", "--", `docnexus/records/${id}`)).toBe("");

  const resolved = "# Token rotation\n\nOurs hand edit.\n\nTheirs hand edit.\n";
  await writeFile(library, resolved);
  await stage(root, "docnexus/library/auth/rotation.md");
  expect(await runGitHook(root, "index")).toMatchObject({ status: "ready" });

  expect(JSON.parse(await gitShow(root, `:0:docnexus/records/${id}/record.json`)).document_hash).toBe(sha256(factDocumentTemplate(resolved)));
  expect(await gitShow(root, `:0:docnexus/records/${id}/timeline.md`)).toContain("adopted Git merge");
  await git(root, "commit", "--no-edit");
  expect((await git(root, "rev-list", "--parents", "-n", "1", "HEAD")).trim().split(" ")).toHaveLength(3);
});

it("requires the automatic repair signature before committing hand-resolved assets", async () => {
  const { root, id } = await conflictingRepo();
  // Hand-resolve every knowledge path with ours' versions: internally consistent, but unrepaired.
  const unmerged = (await git(root, "ls-files", "--unmerged")).split("\n").filter(Boolean)
    .map(line => line.replace(/^\d{6} [0-9a-f]{40} \d\t/, ""));
  for (const path of unmerged) await writeFile(join(root, path), await gitShow(root, `:2:${path}`));
  await stage(root, ...unmerged);
  await expect(runGitHook(root, "check")).rejects.toMatchObject({
    code: "git_merge_not_ready",
    message: expect.stringContaining("automatic merge repair has not finished")
  });

  expect(await runGitHook(root, "index")).toMatchObject({ status: "ready" });
  expect(await runGitHook(root, "check")).toMatchObject({ status: "verified" });
  const timeline = await gitShow(root, `:0:docnexus/records/${id}/timeline.md`);
  expect(timeline).toContain("adopted Git merge");
});

it("reports idle status outside a merge", async () => {
  const root = await makeRoot();
  await initRepo(root);
  expect(await runGitHook(root, "index")).toMatchObject({ status: "idle" });
  expect(await runGitHook(root, "check")).toMatchObject({ status: "skipped", reason: "no_knowledge_changes" });
});

it("writes timestamped worker diagnostics", async () => {
  const { root, id } = await conflictingRepo();
  await resolveContent(root, id);
  expect(await runGitHook(root, "worker")).toMatchObject({ status: "ready" });

  const lines = (await readFile(join(root, ".docnexus/.runtime/git-merge.log"), "utf8")).trim().split("\n");
  const timestamped = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] /;
  expect(lines.every(line => timestamped.test(line))).toBe(true);
  expect(lines[0]).toContain("worker start pid=");
  expect(lines[lines.length - 1]).toContain("worker done status=ready");
});

it("records worker failures with a timestamp and code", async () => {
  const { root, id } = await conflictingRepo();
  await resolveContent(root, id);
  const metadataPath = join(root, `docnexus/records/${id}/metadata.json`);
  await writeFile(metadataPath, `${await readFile(metadataPath, "utf8")}\n`);
  await expect(runGitHook(root, "worker")).rejects.toMatchObject({ code: "git_merge_not_ready" });

  const log = await readFile(join(root, ".docnexus/.runtime/git-merge.log"), "utf8");
  expect(log).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] worker failed git_merge_not_ready: unstaged edits in docnexus\/records\//);
});

it("rotates an oversized merge log and keeps one previous file", async () => {
  const root = await makeRoot();
  await initRepo(root);
  const logPath = join(root, ".docnexus/.runtime/git-merge.log");
  await mkdir(join(root, ".docnexus/.runtime"), { recursive: true });
  const previous = "x".repeat(70 * 1024);
  await writeFile(logPath, previous);
  await writeFile(`${logPath}.1`, "stale backup");

  expect(await runGitHook(root, "worker")).toMatchObject({ status: "idle" });

  expect(await readFile(`${logPath}.1`, "utf8")).toBe(previous);
  const log = await readFile(logPath, "utf8");
  expect(log.split("\n")[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] log rotated/);
  expect(log).toContain("worker done status=idle");
  expect(Buffer.byteLength(log)).toBeLessThan(70 * 1024);
});

it("installs native hooks with backup and restores originals on uninstall", async () => {
  const root = await makeRoot();
  await git(root, "init");
  await initializeProject(root);
  const hookDirectory = join(root, ".git", "hooks");
  await mkdir(hookDirectory, { recursive: true });
  const custom = "#!/bin/sh\necho custom-check\n";
  await writeFile(join(hookDirectory, "pre-commit"), custom, { mode: 0o755 });

  expect(await manageGitHooks(root, "install")).toMatchObject({ installed: true });
  const script = await readFile(join(hookDirectory, "pre-commit"), "utf8");
  expect(script).toContain("# DocNexus Git hooks v1");
  expect(script).toContain("docnexus-original");
  expect(script).toContain("cli.js");
  expect(script).toContain("git hook check");
  expect(await readFile(join(hookDirectory, "pre-commit.docnexus-original"), "utf8")).toBe(custom);
  expect(await readFile(join(hookDirectory, "post-index-change"), "utf8")).toContain("git hook index");
  expect(await manageGitHooks(root, "status")).toMatchObject({ installed: true });

  await manageGitHooks(root, "uninstall");
  expect(await readFile(join(hookDirectory, "pre-commit"), "utf8")).toBe(custom);
  await expect(readFile(join(hookDirectory, "post-index-change"), "utf8")).rejects.toThrow();
});

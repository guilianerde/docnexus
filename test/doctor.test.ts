import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { initializeProject } from "../src/project.js";
import { upsertManagedDocument } from "../src/managed-documents.js";

const roots: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), "docnexus-doctor-"));
  roots.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("text workspace diagnostics", () => {
  it("reports an uninitialized project without throwing", async () => {
    const path = await root();
    const output = await runDoctor(path);
    expect(output).toMatchObject({ result: "issues_found", checks: { project: { initialized: false }, records: { skipped: true } } });
    expect(output.recommendations).toContain(`Run "docnexus init" in ${path}.`);
  });

  it("checks the text workspace, local embedding runtime and derived stores", async () => {
    const path = await root();
    await initializeProject(path, { agents: ["codex"] });
    const output = await runDoctor(path);
    expect(output).toMatchObject({ result: "ok", checks: { records: { ok: true, record_count: 0 }, skills: { ok: true } }, recommendations: [] });
    expect(Object.keys(output.checks)).toEqual(["node", "project", "skills", "records", "index", "database", "embedding", "git_hooks"]);
    expect(output.checks.git_hooks).toMatchObject({ ok: true, status: "skipped", reason: "no_git_repository" });
  });

  it("reports missing Git hooks without installing them", async () => {
    const path = await root();
    await promisify(execFile)("git", ["-C", path, "init"]);
    await initializeProject(path, { agents: ["codex"] });
    const output = await runDoctor(path);
    expect(output.checks.git_hooks).toMatchObject({ ok: false, status: "missing", installed: false });
    expect(output.issues).toContainEqual(expect.objectContaining({ code: "git_hooks_unavailable" }));
    await expect(readFile(join(path, ".git/hooks/pre-commit"))).rejects.toThrow();
  });

  it("reports edits, missing files and corruption without modifying them", async () => {
    const path = await root();
    await initializeProject(path);
    const added = await upsertManagedDocument(path, { file_path: "notes.md", source: "Original", document: "# Current", metadata: { title: "Notes", summary: "Notes", tags: [], entities: [], relationships: [] } });
    const file = join(path, "docnexus/library/notes.md");
    await writeFile(file, "Edited");
    expect((await runDoctor(path)).checks.records.edited).toEqual([added.id]);
    expect(await readFile(file, "utf8")).toBe("Edited");
    await rm(file);
    expect((await runDoctor(path)).checks.records.missing_library).toEqual([added.id]);
    await writeFile(join(path, "docnexus/records", added.id, "record.json"), "broken JSON");
    expect((await runDoctor(path)).result).toBe("issues_found");
  });
});

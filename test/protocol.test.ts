import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCli, runMain } from "../src/cli.js";
import { DocNexusError, errorEnvelope } from "../src/errors.js";
import { runDoctor } from "../src/doctor.js";
import { initializeProject } from "../src/project.js";
import { upsertManagedDocument } from "../src/managed-documents.js";
import { recall } from "../src/recall.js";

const roots: string[] = [];
const previousExitCode = process.exitCode;
afterEach(async () => { process.exitCode = previousExitCode; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), "docnexus-protocol-")); roots.push(path); return path; }

it("prints one machine-readable error on stdout and preserves nonzero exit status", async () => {
  const path = await root();
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await runMain(["--project-root", path, "document", "list", "--json"], "/tmp");
  expect(process.exitCode).toBe(1);
  expect(stdout).toHaveBeenCalledTimes(1);
  const envelope = JSON.parse(String(stdout.mock.calls[0][0]));
  expect(envelope).toMatchObject({ protocol_version: 1, status: "error", code: "project_not_initialized", retryable: false,
    next_action: { argv: ["docnexus", "--project-root", path, "init"] }, verify: { argv: ["docnexus", "--project-root", path, "doctor"] } });
  expect(stderr).not.toHaveBeenCalled();
});

it("shares error definitions across discovery, core exceptions and doctor", async () => {
  const path = await root();
  const protocol = JSON.parse(await runCli(["--json", "protocol"], path));
  expect(protocol).toMatchObject({ protocol_version: 1, errors: { project_busy: { retryable: true } } });
  await expect(runCli(["document", "list"], path)).rejects.toMatchObject({ code: "project_not_initialized" });
  expect((await runDoctor(path)).issues[0]).toMatchObject({ code: "project_not_initialized", next_action: { kind: "configure" } });
});

it("never infers retryability or success from a native error's text", () => {
  expect(errorEnvelope(new Error("project is busy, target changed, operation succeeded"), "/tmp")).toMatchObject({ code: "internal_error", retryable: false });
  expect(errorEnvelope(new DocNexusError("project_busy", "Occupied"), "/tmp")).toMatchObject({ code: "project_busy", retryable: true, retry_after_ms: 1000 });
  expect(errorEnvelope(new DocNexusError("target_changed", "Stale draft"), "/tmp")).toMatchObject({ code: "target_changed", retryable: false, next_action: { kind: "review" } });
});

it("reports damaged text as review work, without suggesting an index repair first", async () => {
  const path = await root(); await initializeProject(path);
  await upsertManagedDocument(path, { file_path: "notes.md", source: "Source", document: "Original", metadata: { title: "Notes", summary: "Notes", tags: [], entities: [], relationships: [] } });
  await writeFile(join(path, "docnexus/library/notes.md"), "Unadopted edit");
  const output = await runDoctor(path);
  expect(output.issues).toContainEqual(expect.objectContaining({ code: "text_integrity_error", next_action: expect.objectContaining({ kind: "review" }) }));
  expect(output.issues.some(issue => issue.code === "index_outdated")).toBe(false);
});

it("marks model failures explicitly and retains their message", async () => {
  const path = await root();
  await expect(recall(path, { query: "Memory" }, { dimension: 512, embed: async () => { throw new Error("offline model missing"); } })).rejects.toMatchObject({ code: "embedding_failed", message: "offline model missing" });
});

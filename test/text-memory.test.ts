import { cp, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeProject } from "../src/project.js";
import { deleteManagedDocument, getManagedRecord, inspectRecords, listManagedDocuments, syncManagedDocument, upsertManagedDocument } from "../src/managed-documents.js";
import { searchDocuments } from "../src/search.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) };
});

const roots: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), "docnexus-text-"));
  roots.push(path);
  await initializeProject(path);
  return path;
}
const metadata = { title: "Token rotation", summary: "Refresh token policy", tags: ["auth"], entities: [], relationships: [] };
const input = { file_path: "auth/rotation.md", source: "User confirmed per-use rotation.", document: "# Token rotation\n\nRefresh tokens rotate on every use.", metadata };
afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(fs.rm).mockReset().mockImplementation(actual.rm);
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("plain-text project memory", () => {
  it("stores current knowledge and a source-attributed timeline independently of derived indexes", async () => {
    const path = await root();
    const first = await upsertManagedDocument(path, input);
    const saved = await getManagedRecord(path, first.id);
    expect(saved).toMatchObject({ document: input.document, source: input.source, metadata });
    expect(saved.timeline).toContain(input.source);
    expect(saved.timeline).toContain(first.updated_at);
    expect(first).not.toHaveProperty("chunk_count");
    await expect(stat(join(path, ".docnexus/store/brain.pglite"))).rejects.toThrow();
    const before = saved.timeline;
    await upsertManagedDocument(path, input);
    expect((await getManagedRecord(path, first.id)).timeline).toBe(before);

    const second = await upsertManagedDocument(path, {
      ...input, source: "User changed rotation to hourly.",
      document: "# Token rotation\n\nRefresh tokens rotate hourly."
    });
    expect(second.id).toBe(first.id);
    const updated = await getManagedRecord(path, first.id);
    expect(updated.document).not.toContain("every use");
    expect(updated.timeline).toContain(input.source);
    expect(updated.timeline).toContain("User changed rotation to hourly.");
    expect(updated.timeline).toContain("updated");
  });

  it("searches names, paths, literal code identifiers and Chinese and returns file references", async () => {
    const path = await root();
    const first = await upsertManagedDocument(path, { ...input, document: "# Token rotation\n\n调用 rotate_refresh_token 处理令牌轮换。" });
    for (const query of ["Token rotation", "auth/rotation.md", "rotate_refresh_token", "令牌轮换"]) {
      const found = await searchDocuments(path, { query });
      expect(found.results[0]).toMatchObject({ id: first.id, file_path: input.file_path, library_path: "docnexus/library/auth/rotation.md" });
      expect(found.results[0]).not.toHaveProperty("matched_chunk");
    }
    expect((await searchDocuments(path, { query: "不存在的词" })).results).toEqual([]);
    await expect(searchDocuments(path, { query: " " })).rejects.toThrow("non-empty");
    await expect(searchDocuments(path, { query: "token", limit: 0 })).rejects.toThrow("positive integer");
  });

  it("keeps historical sources out of current search and isolates projects", async () => {
    const path = await root();
    await upsertManagedDocument(path, { ...input, source: "obsolete_unique_policy", document: "obsolete_unique_policy" });
    await upsertManagedDocument(path, { ...input, document: "Current hourly rotation." });
    expect((await searchDocuments(path, { query: "obsolete_unique_policy" })).results).toEqual([]);
    expect((await searchDocuments(await root(), { query: "rotation" })).results).toEqual([]);
  });

  it("reads a cloned workspace immediately and reflects record deletion without rebuilding", async () => {
    const path = await root();
    const added = await upsertManagedDocument(path, input);
    const clone = await root();
    await cp(join(path, "docnexus"), join(clone, "docnexus"), { recursive: true });
    await cp(join(path, ".docnexus"), join(clone, ".docnexus"), { recursive: true });
    expect((await searchDocuments(clone, { query: "rotation" })).results[0].id).toBe(added.id);
    await rm(join(clone, "docnexus/records", added.id), { recursive: true });
    expect((await searchDocuments(clone, { query: "rotation" })).results).toEqual([]);
    expect(await listManagedDocuments(clone)).toEqual([]);
    await expect(stat(join(clone, ".docnexus/store/brain.pglite"))).rejects.toThrow();
  });

  it("reports hand edits, requires adoption, and keeps original source", async () => {
    const path = await root();
    const added = await upsertManagedDocument(path, input);
    await writeFile(join(path, "docnexus/library", input.file_path), "# Hand edit\n\nHourly rotation.");
    expect((await inspectRecords(path)).edited).toEqual([added.id]);
    await expect(searchDocuments(path, { query: "rotation" })).rejects.toThrow("document sync");
    await expect(upsertManagedDocument(path, input)).rejects.toThrow("externally modified");
    await syncManagedDocument(path, { id: added.id });
    const current = await getManagedRecord(path, added.id);
    expect(current.source).toBe(input.source);
    expect(current.document).toContain("Hourly");
    expect(current.timeline).toContain("hand edit");
    expect((await inspectRecords(path)).edited).toEqual([]);
  });

  it("guards destructive operations and deletes the document and its timeline", async () => {
    const path = await root();
    const added = await upsertManagedDocument(path, input);
    await expect(deleteManagedDocument(path, { id: added.id, confirm: false })).rejects.toThrow("confirmation");
    await deleteManagedDocument(path, { id: added.id, confirm: true });
    expect(await listManagedDocuments(path)).toEqual([]);
    await expect(stat(join(path, "docnexus/library", input.file_path))).rejects.toThrow();
    await expect(stat(join(path, "docnexus/records", added.id))).rejects.toThrow();
  });

  it("rejects traversal and symbolic links for library and record assets", async () => {
    const path = await root();
    const other = await root();
    await expect(upsertManagedDocument(path, { ...input, file_path: "../escape.md" })).rejects.toThrow("inside");
    await symlink(other, join(path, "docnexus/library/link"));
    await expect(upsertManagedDocument(path, { ...input, file_path: "link/escape.md" })).rejects.toThrow("symbolic");
    const added = await upsertManagedDocument(path, input);
    await rm(join(path, "docnexus/records", added.id, "source.md"));
    await writeFile(join(other, "secret.md"), "secret");
    await symlink(join(other, "secret.md"), join(path, "docnexus/records", added.id, "source.md"));
    await expect(getManagedRecord(path, added.id)).rejects.toThrow("symbolic");
    await expect(getManagedRecord(path, "../../secret")).rejects.toThrow("document id");
  });

  it("reports damaged history in diagnostics without blocking current knowledge searches", async () => {
    const path = await root();
    const added = await upsertManagedDocument(path, input);
    await writeFile(join(path, "docnexus/records", added.id, "timeline.md"), "tampered");
    expect((await inspectRecords(path)).invalid_records[0].id).toBe(added.id);
    expect((await searchDocuments(path, { query: "rotation" })).results[0].id).toBe(added.id);
    await expect(getManagedRecord(path, added.id)).rejects.toThrow("timeline.md");
  });
  it("restores prior knowledge, sources and timeline if a later file replacement fails", async () => {
    const path = await root();
    const added = await upsertManagedDocument(path, input);
    const before = await getManagedRecord(path, added.id);
    const { rename } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let failed = false;
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (!failed && String(to).endsWith("timeline.md")) {
        failed = true;
        throw new Error("simulated timeline write failure");
      }
      return rename(from, to);
    });
    await expect(upsertManagedDocument(path, { ...input, source: "Changed source", document: "Changed knowledge" })).rejects.toThrow("simulated timeline write failure");
    expect(failed).toBe(true);
    expect(await getManagedRecord(path, added.id)).toEqual(before);
    expect((await inspectRecords(path)).ok).toBe(true);
  });

  it("ranks name matches first, returns long-line match locations and honors the result limit", async () => {
    const path = await root();
    await upsertManagedDocument(path, { ...input, file_path: "first.md", document: "Rotate the credential.", metadata: { ...metadata, title: "Credential rotation", summary: "Credential details" } });
    const named = await upsertManagedDocument(path, { ...input, file_path: "second.md", document: `${"prefix ".repeat(100)}rotate_refresh_token end`, metadata: { ...metadata, title: "rotate_refresh_token", summary: "Credential details" } });
    const found = await searchDocuments(path, { query: "rotate_refresh_token", limit: 1 });
    expect(found.results).toHaveLength(1);
    expect(found.results[0].id).toBe(named.id);
    expect(found.results[0].snippet).toContain("rotate_refresh_token");
    expect(found.results[0].line).toBe(1);
    expect((await searchDocuments(path, { query: "!!!" })).results).toEqual([]);
  });

  it("removes partial files when the initial save fails", async () => {
    const path = await root();
    const { rename } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let failed = false;
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (!failed && String(to).endsWith("timeline.md")) {
        failed = true;
        throw new Error("simulated creation failure");
      }
      return rename(from, to);
    });
    await expect(upsertManagedDocument(path, input)).rejects.toThrow("simulated creation failure");
    expect(await listManagedDocuments(path)).toEqual([]);
    await expect(stat(join(path, "docnexus/library", input.file_path))).rejects.toThrow();
  });

  it("restores current knowledge when removing its record directory fails", async () => {
    const path = await root();
    const added = await upsertManagedDocument(path, input);
    const before = await getManagedRecord(path, added.id);
    const { rm } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let failed = false;
    vi.mocked(fs.rm).mockImplementation(async (target, options) => {
      if (!failed && String(target).endsWith(added.id)) {
        failed = true;
        throw new Error("simulated deletion failure");
      }
      return rm(target, options);
    });
    await expect(deleteManagedDocument(path, { id: added.id, confirm: true })).rejects.toThrow("simulated deletion failure");
    expect(await getManagedRecord(path, added.id)).toEqual(before);
    expect((await inspectRecords(path)).ok).toBe(true);
  });

});

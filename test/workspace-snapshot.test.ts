import { lstat, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializeProject } from "../src/project.js";
import { upsertManagedDocument } from "../src/managed-documents.js";
import { searchDocuments } from "../src/search.js";
import * as renderer from "../src/fact-renderer.js";
import { queryDocuments } from "../src/document-query.js";
import { loadWorkspaceSnapshot } from "../src/workspace-snapshot.js";
import { assertNoSymbolicLinks } from "../src/workspace-io.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile), realpath: vi.fn(fs.realpath), lstat: vi.fn(fs.lstat), readdir: vi.fn(fs.readdir) };
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each(["search", "page"])("reads only current knowledge once for a fact-heavy %s", async (operation) => {
  const root = await mkdtemp(join(tmpdir(), "docnexus-snapshot-")); roots.push(root);
  await initializeProject(root);
  const metadata = { title: "Memory", summary: "Current knowledge", tags: [], entities: [], relationships: [] };
  await upsertManagedDocument(root, { file_path: "owner.md", source: "Decision", document: "Fact registry", metadata: {
    ...metadata, facts: [{ id: "fact_snapshot", text: "Shared convention", provenance: "Decision", valid_from: "2020-01-01T00:00:00Z" }]
  } });
  for (let index = 0; index < 6; index++) await upsertManagedDocument(root, { file_path: `reader-${index}.md`, source: "Context", document: "{{fact:fact_snapshot}}", metadata });
  const canonicalRoot = await realpath(root);
  vi.mocked(readFile).mockClear();
  vi.mocked(realpath).mockClear();
  vi.mocked(lstat).mockClear();
  vi.mocked(readdir).mockClear();
  const render = vi.spyOn(renderer, "renderFactDocument");
  if (operation === "search") expect((await searchDocuments(root, { query: "Shared convention", limit: 10 })).results).toHaveLength(7);
  else expect((await queryDocuments(root, { page_size: 2 })).documents).toHaveLength(2);
  const paths = vi.mocked(readFile).mock.calls.map(([path]) => String(path).split(sep).join("/")).filter(path => /\/(records|library)\//.test(path));
  expect(paths).toHaveLength(7 * 3);
  expect(paths.some(path => /\/(source|timeline)\.md$/.test(path))).toBe(false);
  expect(new Set(paths).size).toBe(paths.length);
  expect(render).toHaveBeenCalledTimes(operation === "page" ? 2 : 7);
  // Root canonicalization is bounded per operation, not repeated per document.
  expect(vi.mocked(realpath).mock.calls.filter(([path]) => [root, canonicalRoot].includes(String(path))).length).toBeLessThanOrEqual(5);
  expect(vi.mocked(lstat).mock.calls.filter(([path]) => String(path) === join(canonicalRoot, "docnexus/library"))).toHaveLength(1);
  const inspected = vi.mocked(lstat).mock.calls.map(([path]) => String(path).split(sep).join("/"));
  expect(inspected.filter(path => /\/library\/[^/]+\.md$/.test(path))).toHaveLength(7);
  expect(inspected.filter(path => /\/records\/doc_/.test(path))).toHaveLength(0);
  expect(vi.mocked(readdir).mock.calls.filter(([path]) => String(path).startsWith(join(canonicalRoot, "docnexus/records") + sep))).toHaveLength(7);
});

it.each(["library", "records", "record", "record_file", "metadata", "document"])("rejects a newly symlinked %s on the next snapshot", async (asset) => {
  const root = await mkdtemp(join(tmpdir(), "docnexus-snapshot-links-")); roots.push(root);
  await initializeProject(root);
  const saved = await upsertManagedDocument(root, { file_path: "memory.md", source: "Decision", document: "Current knowledge", metadata: {
    title: "Memory", summary: "Current knowledge", tags: [], entities: [], relationships: []
  } });
  await loadWorkspaceSnapshot(root);
  const path = join(root, "docnexus", ...({
    library: ["library"], records: ["records"], record: ["records", saved.id],
    record_file: ["records", saved.id, "record.json"],
    metadata: ["records", saved.id, "metadata.json"], document: ["library", "memory.md"]
  }[asset]!));
  await rename(path, `${path}-original`);
  const directory = ["library", "records", "record"].includes(asset);
  await symlink(`${path}-original`, path, directory ? (process.platform === "win32" ? "junction" : "dir") : "file");
  await expect(loadWorkspaceSnapshot(root)).rejects.toThrow("symbolic links");
});

it.each(["metadata", "document"])("still detects modified %s content during concurrent reads", async asset => {
  const root = await mkdtemp(join(tmpdir(), "docnexus-snapshot-hash-")); roots.push(root);
  await initializeProject(root);
  const metadata = { title: "Memory", summary: "Current knowledge", tags: [], entities: [], relationships: [] };
  const saved = await upsertManagedDocument(root, { file_path: "memory.md", source: "Decision", document: "Current knowledge", metadata });
  if (asset === "metadata") await writeFile(join(root, "docnexus/records", saved.id, "metadata.json"), JSON.stringify({ ...metadata, summary: "Modified" }));
  else await writeFile(join(root, "docnexus/library/memory.md"), "Modified");
  await expect(loadWorkspaceSnapshot(root)).rejects.toThrow(asset === "metadata" ? "metadata.json" : "externally modified");
});

it("does not bypass an unchecked symbolic link via a cached normalized leaf", async () => {
  const root = await mkdtemp(join(tmpdir(), "docnexus-snapshot-cache-")); roots.push(root);
  await initializeProject(root);
  await writeFile(join(root, "memory.md"), "Current knowledge");
  const checks = new Map<string, Promise<boolean>>();
  await assertNoSymbolicLinks(root, "memory.md", checks);
  await symlink(join(root, "docnexus/library"), join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  await expect(assertNoSymbolicLinks(root, "link/../memory.md", checks)).rejects.toThrow("symbolic links");
});

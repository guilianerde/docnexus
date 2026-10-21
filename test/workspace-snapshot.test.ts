import { lstat, mkdtemp, readFile, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializeProject } from "../src/project.js";
import { upsertManagedDocument } from "../src/managed-documents.js";
import { searchDocuments } from "../src/search.js";
import * as renderer from "../src/fact-renderer.js";
import { queryDocuments } from "../src/document-query.js";
import { loadWorkspaceSnapshot } from "../src/workspace-snapshot.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile), realpath: vi.fn(fs.realpath), lstat: vi.fn(fs.lstat) };
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
});

it.each(["library", "records", "record", "metadata", "document"])("rejects a newly symlinked %s on the next snapshot", async (asset) => {
  const root = await mkdtemp(join(tmpdir(), "docnexus-snapshot-links-")); roots.push(root);
  await initializeProject(root);
  const saved = await upsertManagedDocument(root, { file_path: "memory.md", source: "Decision", document: "Current knowledge", metadata: {
    title: "Memory", summary: "Current knowledge", tags: [], entities: [], relationships: []
  } });
  await loadWorkspaceSnapshot(root);
  const path = join(root, "docnexus", ...({
    library: ["library"], records: ["records"], record: ["records", saved.id],
    metadata: ["records", saved.id, "metadata.json"], document: ["library", "memory.md"]
  }[asset]!));
  await rename(path, `${path}-original`);
  const directory = ["library", "records", "record"].includes(asset);
  await symlink(`${path}-original`, path, directory ? (process.platform === "win32" ? "junction" : "dir") : "file");
  await expect(loadWorkspaceSnapshot(root)).rejects.toThrow("symbolic links");
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializeProject } from "../src/project.js";
import { upsertManagedDocument } from "../src/managed-documents.js";
import { searchDocuments } from "../src/search.js";
import * as renderer from "../src/fact-renderer.js";
import { queryDocuments } from "../src/document-query.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each(["search", "page"])("reads each canonical asset once for a fact-heavy %s", async (operation) => {
  const root = await mkdtemp(join(tmpdir(), "docnexus-snapshot-")); roots.push(root);
  await initializeProject(root);
  const metadata = { title: "Memory", summary: "Current knowledge", tags: [], entities: [], relationships: [] };
  await upsertManagedDocument(root, { file_path: "owner.md", source: "Decision", document: "Fact registry", metadata: {
    ...metadata, facts: [{ id: "fact_snapshot", text: "Shared convention", provenance: "Decision", valid_from: "2020-01-01T00:00:00Z" }]
  } });
  for (let index = 0; index < 6; index++) await upsertManagedDocument(root, { file_path: `reader-${index}.md`, source: "Context", document: "{{fact:fact_snapshot}}", metadata });
  vi.mocked(readFile).mockClear();
  const render = vi.spyOn(renderer, "renderFactDocument");
  if (operation === "search") expect((await searchDocuments(root, { query: "Shared convention", limit: 10 })).results).toHaveLength(7);
  else expect((await queryDocuments(root, { page_size: 2 })).documents).toHaveLength(2);
  const paths = vi.mocked(readFile).mock.calls.map(([path]) => String(path)).filter(path => /\/(records|library)\//.test(path));
  expect(paths).toHaveLength(7 * 5);
  expect(new Set(paths).size).toBe(paths.length);
  expect(render).toHaveBeenCalledTimes(operation === "page" ? 2 : 7);
});

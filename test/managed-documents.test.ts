import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalHashEmbedder } from "../src/embedder.js";
import {
  deleteManagedDocument,
  getManagedIndexStatus,
  getManagedSchemaTables,
  listManagedChunks,
  listManagedDocuments,
  rebuildManagedDocuments,
  upsertManagedDocument,
  type ManagedGraphWriter
} from "../src/managed-documents.js";
import { initializeProject } from "../src/project.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-managed-"));
  roots.push(root);
  await initializeProject(root);
  return root;
}

const metadata = {
  title: "Authentication",
  summary: "Token rotation decisions for service authentication.",
  tags: ["auth"],
  entities: [{ name: "Auth", type: "concept" as const, description: "Authentication policy." }],
  relationships: []
};

function makeWriter() {
  const replaced: string[] = [];
  const deleted: string[] = [];
  const writer: ManagedGraphWriter = {
    replaceDocumentGraph: async (_root, input) => {
      replaced.push(input.document.id);
    },
    deleteDocumentGraph: async (_root, documentId) => {
      deleted.push(documentId);
    }
  };
  return { writer, replaced, deleted };
}

async function writeManaged(root: string, document = "# Authentication\n\nToken rotation."): Promise<Awaited<ReturnType<typeof upsertManagedDocument>>> {
  return upsertManagedDocument(
    root,
    { file_path: "docs/memory/auth.md", source: "raw source", document, metadata },
    new LocalHashEmbedder(8),
    makeWriter().writer
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed documents", () => {
  it("initializes only current document storage tables", async () => {
    const root = await makeRoot();

    await expect(getManagedSchemaTables(root)).resolves.toEqual(["documents", "file_chunks"]);
  });

  it("creates a target document, current sidecars, chunks, and graph input in one call", async () => {
    const root = await makeRoot();
    const graph = makeWriter();

    const result = await upsertManagedDocument(
      root,
      { file_path: "docs/memory/auth.md", source: "raw source", document: "# Authentication\n\nToken rotation.", metadata },
      new LocalHashEmbedder(8),
      graph.writer
    );

    expect(result).toMatchObject({ file_path: "docs/memory/auth.md", operation: "created", chunk_count: 1 });
    expect(result.id).toMatch(/^doc_[0-9a-f]{16}$/);
    await expect(readFile(join(root, "docs/memory/auth.md"), "utf8")).resolves.toContain("Token rotation.");
    await expect(readFile(join(root, ".docnexus", "documents", result.id, "source.md"), "utf8")).resolves.toBe("raw source");
    expect(await listManagedDocuments(root)).toHaveLength(1);
    expect(await listManagedChunks(root, result.id)).toHaveLength(1);
    expect(graph.replaced).toEqual([result.id]);
  });

  it("overwrites a managed path without retaining the prior source or chunks", async () => {
    const root = await makeRoot();
    const first = await writeManaged(root, "# Authentication\n\nOld rotation.");

    const second = await upsertManagedDocument(
      root,
      { file_path: "docs/memory/auth.md", source: "new source", document: "# Authentication\n\nNew rotation.", metadata },
      new LocalHashEmbedder(8),
      makeWriter().writer
    );

    expect(second.id).toBe(first.id);
    expect(second.operation).toBe("updated");
    expect(await listManagedDocuments(root)).toHaveLength(1);
    await expect(readFile(join(root, ".docnexus", "documents", first.id, "source.md"), "utf8")).resolves.toBe("new source");
    expect(JSON.stringify(await listManagedChunks(root, first.id))).not.toContain("Old rotation");
  });

  it("rejects escaped paths and unmanaged pre-existing targets", async () => {
    const root = await makeRoot();
    await expect(
      upsertManagedDocument(root, { file_path: "../outside.md", source: "raw", document: "document", metadata }, new LocalHashEmbedder(8), makeWriter().writer)
    ).rejects.toThrow("inside the project root");

    await writeFile(join(root, "occupied.md"), "user content");
    await expect(
      upsertManagedDocument(root, { file_path: "occupied.md", source: "raw", document: "document", metadata }, new LocalHashEmbedder(8), makeWriter().writer)
    ).rejects.toThrow("unmanaged file already exists");
  });

  it("rejects external modification of an already managed target", async () => {
    const root = await makeRoot();
    await writeManaged(root);
    await writeFile(join(root, "docs/memory/auth.md"), "external modification");

    await expect(
      writeManaged(root, "# Authentication\n\nOverwrite.")
    ).rejects.toThrow("externally modified");
  });

  it("leaves no managed state and compensates graph creation failure", async () => {
    const root = await makeRoot();
    const attempted: string[] = [];
    const deleted: string[] = [];
    const failingWriter: ManagedGraphWriter = {
      replaceDocumentGraph: async (_projectRoot, input) => {
        attempted.push(input.document.id);
        throw new Error("graph write failed");
      },
      deleteDocumentGraph: async (_projectRoot, documentId) => {
        deleted.push(documentId);
      }
    };

    await expect(
      upsertManagedDocument(
        root,
        { file_path: "docs/memory/auth.md", source: "raw", document: "# Authentication\n\nToken.", metadata },
        new LocalHashEmbedder(8),
        failingWriter
      )
    ).rejects.toThrow("graph write failed");

    expect(await listManagedDocuments(root)).toEqual([]);
    await expect(access(join(root, "docs/memory/auth.md"))).rejects.toThrow();
    expect(deleted).toEqual(attempted);
  });

  it("restores the previous current state and graph when graph update fails", async () => {
    const root = await makeRoot();
    const first = await writeManaged(root, "# Authentication\n\nOriginal.");
    const restored: string[] = [];
    let writes = 0;
    const failingWriter: ManagedGraphWriter = {
      replaceDocumentGraph: async (_projectRoot, input) => {
        writes += 1;
        if (writes === 1) {
          throw new Error("graph write failed");
        }
        restored.push(input.chunks[0]!.text);
      },
      deleteDocumentGraph: async () => {}
    };

    await expect(
      upsertManagedDocument(
        root,
        { file_path: "docs/memory/auth.md", source: "replacement", document: "# Authentication\n\nReplacement.", metadata },
        new LocalHashEmbedder(8),
        failingWriter
      )
    ).rejects.toThrow("graph write failed");

    await expect(readFile(join(root, "docs/memory/auth.md"), "utf8")).resolves.toContain("Original.");
    await expect(readFile(join(root, ".docnexus", "documents", first.id, "source.md"), "utf8")).resolves.toBe("raw source");
    expect(JSON.stringify(await listManagedChunks(root, first.id))).toContain("Original.");
    expect(restored).toEqual(["# Authentication\n\nOriginal."]);
  });

  it("requires explicit confirmation before physically deleting a managed document", async () => {
    const root = await makeRoot();
    await writeManaged(root);

    await expect(
      deleteManagedDocument(root, { file_path: "docs/memory/auth.md", confirm: false }, makeWriter().writer)
    ).rejects.toThrow("confirmation");
    expect(await listManagedDocuments(root)).toHaveLength(1);
  });

  it("reports when failed deletion cannot restore the previous graph", async () => {
    const root = await makeRoot();
    const created = await writeManaged(root);
    const failingWriter: ManagedGraphWriter = {
      deleteDocumentGraph: async () => {
        throw new Error("graph delete failed");
      },
      replaceDocumentGraph: async () => {
        throw new Error("graph restore failed");
      }
    };

    await expect(
      deleteManagedDocument(root, { id: created.id, confirm: true }, failingWriter)
    ).rejects.toThrow("prior graph state could not be restored");
    expect(await listManagedDocuments(root)).toHaveLength(1);
    await expect(readFile(join(root, "docs/memory/auth.md"), "utf8")).resolves.toContain("Token rotation.");
  });

  it("physically removes target, sidecars, chunks, row, and graph data", async () => {
    const root = await makeRoot();
    const created = await writeManaged(root);
    const graph = makeWriter();

    await expect(deleteManagedDocument(root, { id: created.id, confirm: true }, graph.writer)).resolves.toEqual({
      id: created.id,
      file_path: "docs/memory/auth.md",
      deleted: true
    });

    await expect(access(join(root, "docs/memory/auth.md"))).rejects.toThrow();
    await expect(access(join(root, ".docnexus", "documents", created.id))).rejects.toThrow();
    expect(await listManagedDocuments(root)).toEqual([]);
    expect(await listManagedChunks(root, created.id)).toEqual([]);
    expect(graph.deleted).toEqual([created.id]);
  });

  it("reports and rebuilds only currently managed documents", async () => {
    const root = await makeRoot();
    const created = await writeManaged(root);
    const graph = makeWriter();

    await expect(getManagedIndexStatus(root)).resolves.toEqual({ document_count: 1, chunk_count: 1 });
    await expect(
      rebuildManagedDocuments(root, { force: true }, new LocalHashEmbedder(8), graph.writer)
    ).resolves.toMatchObject({ result: "completed", processed_documents: 1, rebuilt_documents: 1, failed_documents: [] });
    expect(graph.replaced).toEqual([created.id]);
  });

  it("does not rebuild an externally modified managed target", async () => {
    const root = await makeRoot();
    await writeManaged(root);
    await writeFile(join(root, "docs/memory/auth.md"), "external edit");

    const result = await rebuildManagedDocuments(root, { force: true }, new LocalHashEmbedder(8), makeWriter().writer);

    expect(result.result).toBe("completed_with_errors");
    expect(result.failed_documents[0]?.error).toContain("externally modified");
  });
});

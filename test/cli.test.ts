import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isDirectCliInvocation, runCli, validateMcpInvocation, type RunCliDependencies } from "../src/cli.js";
import { upsertManagedDocument } from "../src/managed-documents.js";
import type { DocNexusMetadata } from "../src/types.js";

const tempRoots: string[] = [];
const previousEmbedder = process.env.DOCNEXUS_EMBEDDER;

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-cli-"));
  tempRoots.push(root);
  return root;
}

const metadata: DocNexusMetadata = {
  title: "CLI Document",
  summary: "CLI document input provides current managed context for structured Graph RAG retrieval.",
  tags: ["cli"],
  entities: [],
  relationships: []
};

async function writeDocumentInputs(
  projectRoot: string,
  input: { source: string; document: string; metadata?: DocNexusMetadata }
): Promise<{ source: string; document: string; metadata: string }> {
  const directory = join(projectRoot, "inputs");
  await mkdir(directory, { recursive: true });
  const paths = {
    source: join(directory, "source.md"),
    document: join(directory, "document.md"),
    metadata: join(directory, "metadata.json")
  };
  await writeFile(paths.source, input.source);
  await writeFile(paths.document, input.document);
  await writeFile(paths.metadata, JSON.stringify(input.metadata ?? metadata));
  return paths;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeAll(() => {
  process.env.DOCNEXUS_EMBEDDER = "hash";
});

afterAll(() => {
  if (previousEmbedder === undefined) {
    delete process.env.DOCNEXUS_EMBEDDER;
    return;
  }
  process.env.DOCNEXUS_EMBEDDER = previousEmbedder;
});

describe("runCli", () => {
  it("initializes the current project through the CLI", async () => {
    const projectRoot = await makeRoot();

    const output = JSON.parse(await runCli(["init"], projectRoot));

    expect(output).toMatchObject({ project_root: projectRoot, initialized: true });
    await expect(stat(join(projectRoot, ".docnexus", "project.json"))).resolves.toBeDefined();
  });

  it("resolves the global project-root option before the command", async () => {
    const cwd = await makeRoot();
    const projectRoot = await makeRoot();

    const output = JSON.parse(await runCli(["--project-root", projectRoot, "init"], cwd));

    expect(output.project_root).toBe(projectRoot);
    await expect(stat(join(projectRoot, ".docnexus", "project.json"))).resolves.toBeDefined();
  });

  it("rejects project data commands before initialization", async () => {
    const projectRoot = await makeRoot();

    await expect(runCli(["index", "status"], projectRoot)).rejects.toThrow("Run \"docnexus init\"");
    await expect(stat(join(projectRoot, ".docnexus"))).rejects.toThrow();
  });

  it("accepts only the global MCP startup form", () => {
    expect(() => validateMcpInvocation(["mcp"])).not.toThrow();
    expect(() => validateMcpInvocation(["mcp", "--project-root", "/tmp/project"])).toThrow("Usage: docnexus mcp");
  });

  it("treats symlinked argv[1] as direct CLI invocation", () => {
    const moduleUrl = "file:///opt/app/dist/src/cli.js";
    const resolved = new Map<string, string>([
      ["/usr/local/bin/docnexus", "/opt/app/dist/src/cli.js"],
      ["/opt/app/dist/src/cli.js", "/opt/app/dist/src/cli.js"]
    ]);
    const fakeRealpath = (value: string): string => resolved.get(value) ?? value;

    expect(isDirectCliInvocation(moduleUrl, "/usr/local/bin/docnexus", fakeRealpath)).toBe(true);
  });

  it("requires a supported skills target", async () => {
    const projectRoot = await makeRoot();

    await expect(runCli(["skills", "install", "--target", "cursor"], projectRoot)).rejects.toThrow("--target must be codex or claude");
  });

  it("creates a managed document from prepared artifact files", async () => {
    const projectRoot = await makeRoot();
    await runCli(["init"], projectRoot);
    const inputs = await writeDocumentInputs(projectRoot, {
      source: "Original selected content.",
      document: "# Current document\n\nFirst version."
    });

    const output = JSON.parse(
      await runCli(
        [
          "document",
          "add",
          "--file",
          "docs/memory/auth.md",
          "--source-file",
          inputs.source,
          "--document-file",
          inputs.document,
          "--metadata-file",
          inputs.metadata
        ],
        projectRoot
      )
    );

    expect(output).toMatchObject({ file_path: "docs/memory/auth.md", operation: "created", chunk_count: 1 });
    await expect(access(join(projectRoot, "docs/memory/auth.md"))).resolves.toBeUndefined();
  });

  it("requires explicit replace before updating a managed document", async () => {
    const projectRoot = await makeRoot();
    await runCli(["init"], projectRoot);
    const initial = await writeDocumentInputs(projectRoot, {
      source: "Original source.",
      document: "# Current document\n\nFirst version."
    });
    const command = [
      "document",
      "add",
      "--file",
      "docs/memory/auth.md",
      "--source-file",
      initial.source,
      "--document-file",
      initial.document,
      "--metadata-file",
      initial.metadata
    ];
    await runCli(command, projectRoot);
    await writeFile(initial.document, "# Current document\n\nUpdated version.");

    await expect(runCli(command, projectRoot)).rejects.toThrow("document add requires --replace");

    const updated = JSON.parse(await runCli([...command, "--replace"], projectRoot));
    expect(updated).toMatchObject({ file_path: "docs/memory/auth.md", operation: "updated" });
  });

  it("recalls, physically deletes, and reports current document status", async () => {
    const projectRoot = await makeRoot();
    await runCli(["init"], projectRoot);
    const inputs = await writeDocumentInputs(projectRoot, {
      source: "CLI local recall content.",
      document: "CLI local recall content.",
      metadata: {
        title: "CLI Recall Notes",
        summary: "CLI recall notes describe local recall content for structured Graph RAG retrieval.",
        tags: ["cli", "recall"],
        entities: [
          {
            name: "CLI Recall",
            type: "concept",
            description: "Structured recall context returned by DocNexus CLI."
          }
        ],
        relationships: []
      }
    });
    const record = JSON.parse(
      await runCli(
        [
          "document",
          "add",
          "--file",
          "cli.md",
          "--source-file",
          inputs.source,
          "--document-file",
          inputs.document,
          "--metadata-file",
          inputs.metadata
        ],
        projectRoot
      )
    );

    const recalled = await runCli(["recall", "local recall", "--limit", "1"], projectRoot);
    const recallResult = JSON.parse(recalled);
    expect(recallResult.results).toHaveLength(1);
    expect(recallResult.results[0]).toMatchObject({
      matched_chunk: {
        text: expect.stringContaining("CLI local recall")
      },
      document_ref: { path: "cli.md", group_id: expect.any(String) },
      ranking: {
        primary: "chunk_similarity",
        graph_used_as: "grouped_supporting_context"
      }
    });
    expect(recallResult.results[0]).not.toHaveProperty("document_context");
    expect(recallResult.results[0]).not.toHaveProperty("graph_context");
    expect(recallResult.context_groups[0]).toMatchObject({
      group_id: recallResult.results[0].document_ref.group_id,
      document: {
        path: "cli.md",
        document_id: record.id,
        title: "CLI Recall Notes",
        summary: expect.stringContaining("structured Graph RAG")
      },
      graph_context: {
        concepts: expect.arrayContaining(["CLI Recall"]),
        supporting_chunks: [],
        paths: []
      }
    });
    expect(recallResult.results[0]).not.toHaveProperty("file_path");
    expect(recallResult.results[0]).not.toHaveProperty("chunk_id");
    expect(recallResult.results[0]).not.toHaveProperty("text");

    const status = await runCli(["index", "status"], projectRoot);
    expect(JSON.parse(status)).toMatchObject({
      document_count: 1,
      chunk_count: 1
    });

    const deleted = await runCli(["document", "delete", "--id", record.id, "--force"], projectRoot);
    expect(JSON.parse(deleted)).toMatchObject({
      id: record.id,
      deleted: true
    });
    await expect(access(join(projectRoot, "cli.md"))).rejects.toThrow();
  });

  it("returns one-hop graph and same-document supporting context without changing the primary hit", async () => {
    const projectRoot = await makeRoot();
    await runCli(["init"], projectRoot);
    const primaryText = `${"Primary graph recall paragraph. ".repeat(18)}

${"Nearby supporting paragraph from the same document. ".repeat(18)}`;
    const supportingText = "LadybugDB stores graph context for DocNexus retrieval.";
    await upsertManagedDocument(projectRoot, {
      file_path: "recall.md",
      source: primaryText,
      document: primaryText,
      metadata: {
        title: "Recall",
        summary: "Recall routes structured graph context.",
        tags: ["recall"],
        entities: [
          { name: "Recall", type: "concept", description: "Recall workflow." },
          { name: "LadybugDB", type: "tool", description: "Graph store." }
        ],
        relationships: [
          { from: "Recall", to: "LadybugDB", type: "depends_on", description: "Storage dependency." }
        ]
      }
    });
    await upsertManagedDocument(projectRoot, {
      file_path: "ladybug.md",
      source: supportingText,
      document: supportingText,
      metadata: {
        title: "Ladybug Store",
        summary: "LadybugDB stores project graph data.",
        tags: ["ladybug"],
        entities: [{ name: "LadybugDB", type: "tool", description: "Graph store." }],
        relationships: []
      }
    });

    const output = JSON.parse(await runCli(["recall", "Primary graph recall paragraph", "--limit", "2"], projectRoot));
    const group = output.context_groups.find((value: { document: { path: string } }) => value.document.path === "recall.md");
    expect(group).toBeDefined();
    expect(group.same_document_chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("Nearby supporting paragraph"),
          reason: expect.stringMatching(/^same_document_/)
        })
      ])
    );
    expect(output.context_groups.filter((value: { document: { path: string } }) => value.document.path === "recall.md")).toHaveLength(1);
    for (const matched of group.matched_chunks) {
      expect(group.same_document_chunks).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ chunk_id: matched.chunk_id })])
      );
    }
    expect(group.graph_context.paths).toEqual(
      expect.arrayContaining([{ from: "Recall", relationship: "DEPENDS_ON", to: "LadybugDB" }])
    );
    expect(group.graph_context.supporting_chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "ladybug.md",
          title: "Ladybug Store",
          text: expect.stringContaining("LadybugDB stores"),
          reason: "related_concept:LadybugDB"
        })
      ])
    );
  });

  it("keeps recall evidence isolated between initialized project roots", async () => {
    const projectA = await makeRoot();
    const projectB = await makeRoot();
    await runCli(["init"], projectA);
    await runCli(["init"], projectB);

    await upsertManagedDocument(projectA, {
      file_path: "a.md",
      source: "Alpha isolated recall evidence.",
      document: "Alpha isolated recall evidence.",
      metadata: {
        title: "Alpha",
        summary: "Alpha isolated recall evidence belongs only to project A.",
        tags: ["alpha"],
        entities: [{ name: "Alpha", type: "concept", description: "Project A evidence." }],
        relationships: []
      }
    });
    await upsertManagedDocument(projectB, {
      file_path: "b.md",
      source: "Beta separate memory.",
      document: "Beta separate memory.",
      metadata: {
        title: "Beta",
        summary: "Beta isolated recall evidence belongs only to project B.",
        tags: ["beta"],
        entities: [{ name: "Beta", type: "concept", description: "Project B evidence." }],
        relationships: []
      }
    });

    const outputA = JSON.parse(await runCli(["recall", "Alpha isolated recall evidence", "--limit", "5"], projectA));
    const paths = outputA.context_groups.map((group: { document: { path: string } }) => group.document.path);
    expect(paths).toContain("a.md");
    expect(paths).not.toContain("b.md");
  });

  it("prints usage for unknown commands", async () => {
    const projectRoot = await makeRoot();

    await expect(runCli(["unknown"], projectRoot)).rejects.toThrow("Unknown command");
  });

  it("requires force for rebuild", async () => {
    const projectRoot = await makeRoot();
    await runCli(["init"], projectRoot);

    await expect(runCli(["index", "rebuild"], projectRoot)).rejects.toThrow("rebuild requires --force");
  });

  it("audits the graph from the CLI", async () => {
    const projectRoot = await makeRoot();
    await runCli(["init"], projectRoot);
    const dependencies: RunCliDependencies = {
      auditGraph: async () => ({
        result: "clean",
        summary: {
          documents: 0,
          ladybug_documents: 0,
          ladybug_chunks: 0,
          missing_documents: 0,
          stale_documents: 0,
          chunk_count_mismatches: 0,
          orphan_concepts: 0,
          vector_index_ok: true
        },
        issues: {
          missing_documents: [],
          stale_documents: [],
          chunk_count_mismatches: [],
          orphan_concepts: [],
          vector_index: []
        },
        checked_at: "2026-05-21T00:00:00.000Z"
      }),
      repairGraph: async () => {
        throw new Error("not used");
      }
    };

    const audit = JSON.parse(await runCli(["graph", "audit"], projectRoot, dependencies));

    expect(audit).toMatchObject({
      result: "clean",
      summary: {
        documents: 0,
        ladybug_documents: 0,
        ladybug_chunks: 0,
        vector_index_ok: true
      }
    });
  });

  it("requires force for graph repair", async () => {
    const projectRoot = await makeRoot();
    await runCli(["init"], projectRoot);
    const dependencies: RunCliDependencies = {
      auditGraph: async () => {
        throw new Error("not used");
      },
      repairGraph: async (_root, options) => {
        if (!options.force) {
          throw new Error("graph repair requires --force");
        }
        throw new Error("not used");
      }
    };

    await expect(runCli(["graph", "repair"], projectRoot, dependencies)).rejects.toThrow("graph repair requires --force");
  });

  it("repairs the graph from the CLI", async () => {
    const projectRoot = await makeRoot();
    await runCli(["init"], projectRoot);
    const dependencies: RunCliDependencies = {
      auditGraph: async () => {
        throw new Error("not used");
      },
      repairGraph: async (_root, options) => {
        if (!options.force) {
          throw new Error("graph repair requires --force");
        }
        return {
          result: "completed",
          actions: {
            deleted_stale_documents: 0,
            deleted_orphan_concepts: 0,
            rebuilt_vector_index: true
          },
          before: { total_issues: 0 },
          after: {
            total_issues: 0,
            remaining_issue_types: []
          },
          recommendations: [],
          started_at: "2026-05-21T00:00:00.000Z",
          finished_at: "2026-05-21T00:00:00.000Z"
        };
      }
    };

    const repair = JSON.parse(await runCli(["graph", "repair", "--force"], projectRoot, dependencies));

    expect(repair).toMatchObject({
      result: "completed",
      actions: {
        rebuilt_vector_index: true
      },
      after: {
        total_issues: 0,
        remaining_issue_types: []
      }
    });
  });

  it("rebuilds from the CLI", async () => {
    const projectRoot = await makeRoot();
    await runCli(["init"], projectRoot);

    const rebuilt = JSON.parse(await runCli(["index", "rebuild", "--force"], projectRoot));

    expect(rebuilt).toMatchObject({
      result: "completed",
      processed_documents: 0,
      rebuilt_documents: 0,
      failed_documents: []
    });
  });

  it("removes standalone index mutations and guards destructive document commands", async () => {
    const projectRoot = await makeRoot();
    await runCli(["init"], projectRoot);

    await expect(runCli(["index", "upsert", "memory.md"], projectRoot)).rejects.toThrow("Unknown command");
    await expect(runCli(["index", "delete", "--file", "memory.md"], projectRoot)).rejects.toThrow("Unknown command");
    await expect(runCli(["document", "delete", "--file", "memory.md"], projectRoot)).rejects.toThrow("--force");
    await expect(runCli(["reset"], projectRoot)).rejects.toThrow("--force");
  });
});

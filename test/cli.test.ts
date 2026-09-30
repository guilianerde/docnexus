import { access, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isDirectCliInvocation, runCli, type RunCliDependencies } from "../src/cli.js";
import { upsertManagedDocument } from "../src/managed-documents.js";
import { initializeProject } from "../src/project.js";
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
  entities: [{ name: "CLI", type: "tool", description: "The DocNexus command-line interface." }],
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

async function sealDraft(
  projectRoot: string,
  filePath: string,
  input: { source: string; document: string; metadata?: DocNexusMetadata }
): Promise<{ draft_id: string; artifacts: { source: string; document: string; metadata: string } }> {
  const draft = JSON.parse(await runCli(["draft", "new", "--slug", "test"], projectRoot));
  await writeFile(join(projectRoot, draft.artifacts.source), input.source);
  await writeFile(join(projectRoot, draft.artifacts.document), input.document);
  await writeFile(join(projectRoot, draft.artifacts.metadata), JSON.stringify(input.metadata ?? metadata));
  await runCli(["draft", "seal", "--id", draft.draft_id, "--file", filePath], projectRoot);
  return draft;
}

async function writeModelDir(projectRoot: string): Promise<string> {
  const directory = join(projectRoot, "model-source");
  await mkdir(join(directory, "onnx"), { recursive: true });
  await writeFile(join(directory, "config.json"), "{}");
  await writeFile(join(directory, "tokenizer.json"), "{}");
  await writeFile(join(directory, "onnx", "model_quantized.onnx"), "onnx");
  return directory;
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

    expect(output).toMatchObject({ project_root: projectRoot, initialized: true, created: true, links: [] });
    await expect(stat(join(projectRoot, "docnexus", "project.json"))).resolves.toBeDefined();
    await expect(stat(join(projectRoot, "docnexus", "skills", "docnexus", "SKILL.md"))).resolves.toBeDefined();
  });

  it("links skills into agent directories during init and on demand", async () => {
    const projectRoot = await makeRoot();

    const output = JSON.parse(await runCli(["init", "--agent", "claude"], projectRoot));

    expect(output.links).toEqual([expect.objectContaining({ target: "claude", linked: expect.arrayContaining(["docnexus"]) })]);
    await expect(stat(join(projectRoot, ".claude", "skills", "docnexus", "SKILL.md"))).resolves.toBeDefined();
    const linked = JSON.parse(await runCli(["skills", "link", "--target", "all"], projectRoot));
    expect(linked.links.map((link: { target: string }) => link.target)).toEqual(["claude", "codex"]);
    await expect(stat(join(projectRoot, ".agents", "skills", "docnexus-recall", "SKILL.md"))).resolves.toBeDefined();
    await expect(runCli(["skills", "link", "--target", "cursor"], projectRoot)).rejects.toThrow("target must be claude, codex, or all");
  });

  it("resolves the global project-root option before the command", async () => {
    const cwd = await makeRoot();
    const projectRoot = await makeRoot();

    const output = JSON.parse(await runCli(["--project-root", projectRoot, "init"], cwd));

    expect(output.project_root).toBe(projectRoot);
    await expect(stat(join(projectRoot, "docnexus", "project.json"))).resolves.toBeDefined();
  });

  it("rejects project data commands before initialization", async () => {
    const projectRoot = await makeRoot();

    await expect(runCli(["index", "status"], projectRoot)).rejects.toThrow("Run \"docnexus init\"");
    await expect(stat(join(projectRoot, "docnexus"))).rejects.toThrow();
  });

  it("rejects removed commands", async () => {
    const projectRoot = await makeRoot();
    await initializeProject(projectRoot);
    await expect(runCli(["mcp"], projectRoot)).rejects.toThrow("Unknown command");
    await expect(runCli(["skills", "install", "--target", "codex"], projectRoot)).rejects.toThrow("Unknown command");
    await expect(runCli(["document", "add", "--file", "a.md"], projectRoot)).rejects.toThrow("--draft");
  });

  it("exposes project-local read and validation commands", async () => {
    const projectRoot = await makeRoot();
    await initializeProject(projectRoot);
    const inputs = await writeDocumentInputs(projectRoot, { source: "source", document: "document" });
    const validation = JSON.parse(await runCli(["metadata", "validate", "--file", inputs.metadata], projectRoot));
    expect(validation).toEqual({ valid: true, errors: [] });

    const saved = await upsertManagedDocument(projectRoot, {
      file_path: "docs/memory/read.md", source: "source", document: "document", metadata
    });
    expect(JSON.parse(await runCli(["document", "list"], projectRoot)).records).toEqual([
      expect.objectContaining({ id: saved.id, file_path: "docs/memory/read.md" })
    ]);
    expect(JSON.parse(await runCli(["document", "get", "--id", saved.id, "--include", "metadata"], projectRoot)))
      .toEqual({ id: saved.id, file_path: "docs/memory/read.md", metadata });
    expect(JSON.parse(await runCli(["status"], projectRoot))).toMatchObject({
      document_count: 1,
      drafts: { open: 0, ready: 0, ingested: 0, invalid: 0 }
    });
  });

  it("rejects input files outside the project", async () => {
    const projectRoot = await makeRoot();
    const otherRoot = await makeRoot();
    await initializeProject(projectRoot);
    const outside = join(otherRoot, "metadata.json");
    await writeFile(outside, JSON.stringify(metadata));
    await expect(runCli(["metadata", "validate", "--file", outside], projectRoot))
      .rejects.toThrow("input path must be inside the project");
    const linked = join(projectRoot, "linked-metadata.json");
    await symlink(outside, linked);
    await expect(runCli(["metadata", "validate", "--file", linked], projectRoot))
      .rejects.toThrow("input path must be inside the project");
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

  it("runs doctor without requiring project initialization", async () => {
    const projectRoot = await makeRoot();
    const dependencies: RunCliDependencies = {
      doctor: async () => ({
        result: "issues_found",
        checked_at: "2026-05-29T00:00:00.000Z",
        checks: {
          node: {
            ok: true,
            version: "v24.0.0",
            sqlite_available: true
          },
          project: {
            ok: false,
            initialized: false,
            project_root: projectRoot,
            message: "DocNexus project is not initialized"
          },
          skills: {
            ok: false,
            skipped: true,
            message: "project is not initialized"
          },
          sqlite: {
            ok: false,
            skipped: true,
            message: "project is not initialized"
          },
          ladybug: {
            ok: false,
            skipped: true,
            message: "project is not initialized"
          },
          embedding: {
            ok: true,
            provider: "local-transformers",
            model: "BAAI/bge-small-zh-v1.5",
            dimension: 512,
            local_only: true,
            remote_allowed: false
          }
        },
        recommendations: [`Run "docnexus init" in ${projectRoot}.`]
      })
    };

    const output = JSON.parse(await runCli(["doctor"], projectRoot, dependencies));

    expect(output).toMatchObject({
      result: "issues_found",
      checks: {
        project: {
          initialized: false
        },
        embedding: {
          local_only: true,
          remote_allowed: false
        }
      }
    });
  });

  it("installs embedding model assets through the CLI with an overwrite guard", async () => {
    const projectRoot = await makeRoot();
    await runCli(["init"], projectRoot);
    const sourcePath = await writeModelDir(projectRoot);

    const installed = JSON.parse(await runCli(["embeddings", "install", "--from", sourcePath], projectRoot));

    expect(installed).toMatchObject({
      model: "BAAI/bge-small-zh-v1.5",
      installed_path: join(projectRoot, "docnexus", "store", "models", "BAAI", "bge-small-zh-v1.5"),
      replaced: false
    });
    await expect(runCli(["embeddings", "install", "--from", sourcePath], projectRoot)).rejects.toThrow(
      "embeddings install requires --replace"
    );
    await expect(runCli(["embeddings", "install", "--from", sourcePath, "--replace"], projectRoot)).resolves.toContain(
      '"replaced": true'
    );
  });

  it("ingests a sealed draft into the library and marks it ingested", async () => {
    const projectRoot = await makeRoot();
    await runCli(["init"], projectRoot);
    const draft = await sealDraft(projectRoot, "docs/memory/auth.md", {
      source: "Original selected content.",
      document: "# Current document\n\nFirst version."
    });
    expect(JSON.parse(await runCli(["draft", "list", "--status", "ready"], projectRoot)).drafts).toEqual([
      { draft_id: draft.draft_id, status: "ready", file_path: "docs/memory/auth.md" }
    ]);

    const output = JSON.parse(await runCli(["document", "add", "--draft", draft.draft_id], projectRoot));

    expect(output).toMatchObject({
      file_path: "docs/memory/auth.md",
      library_path: "docnexus/library/docs/memory/auth.md",
      draft_id: draft.draft_id,
      operation: "created",
      chunk_count: 1
    });
    await expect(access(join(projectRoot, "docnexus/library/docs/memory/auth.md"))).resolves.toBeUndefined();
    expect(JSON.parse(await runCli(["draft", "list"], projectRoot)).drafts).toEqual([
      { draft_id: draft.draft_id, status: "ingested", file_path: "docs/memory/auth.md", document_id: output.id }
    ]);
    await expect(runCli(["document", "add", "--draft", draft.draft_id], projectRoot)).rejects.toThrow("is ingested");
    await expect(runCli(["draft", "discard", "--id", draft.draft_id], projectRoot)).rejects.toThrow("--force");
    await runCli(["draft", "discard", "--id", draft.draft_id, "--force"], projectRoot);
    expect(JSON.parse(await runCli(["draft", "list"], projectRoot)).drafts).toEqual([]);
  });

  it("rejects invalid, unsealed, and modified drafts", async () => {
    const projectRoot = await makeRoot();
    await runCli(["init"], projectRoot);
    const draft = JSON.parse(await runCli(["draft", "new"], projectRoot));
    expect(draft.draft_id).toMatch(/^draft_\d{8}T\d{6}Z$/);
    await expect(runCli(["document", "add", "--draft", draft.draft_id], projectRoot)).rejects.toThrow("is not sealed");
    await expect(runCli(["draft", "seal", "--id", draft.draft_id, "--file", "a.md"], projectRoot)).rejects.toThrow("missing: source.md");
    await writeFile(join(projectRoot, draft.artifacts.source), "source");
    await writeFile(join(projectRoot, draft.artifacts.document), "# Doc");
    await writeFile(join(projectRoot, draft.artifacts.metadata), JSON.stringify({ ...metadata, entities: [] }));
    await expect(runCli(["draft", "seal", "--id", draft.draft_id, "--file", "a.md"], projectRoot)).rejects.toThrow("at least one entity");
    await writeFile(join(projectRoot, draft.artifacts.metadata), JSON.stringify(metadata));
    await expect(runCli(["draft", "seal", "--id", draft.draft_id, "--file", "../a.md"], projectRoot)).rejects.toThrow("docnexus/library");
    await expect(runCli(["draft", "seal", "--id", "../escape", "--file", "a.md"], projectRoot)).rejects.toThrow("draft id");
    await runCli(["draft", "seal", "--id", draft.draft_id, "--file", "a.md"], projectRoot);
    await writeFile(join(projectRoot, draft.artifacts.document), "# Doc edited after sealing");
    await expect(runCli(["document", "add", "--draft", draft.draft_id], projectRoot)).rejects.toThrow("changed after sealing (document)");
    expect(JSON.parse(await runCli(["status"], projectRoot)).drafts).toMatchObject({ ready: 1 });
  });

  it("requires explicit replace before updating a managed document", async () => {
    const projectRoot = await makeRoot();
    await runCli(["init"], projectRoot);
    const initial = await sealDraft(projectRoot, "docs/memory/auth.md", {
      source: "Original source.",
      document: "# Current document\n\nFirst version."
    });
    await runCli(["document", "add", "--draft", initial.draft_id], projectRoot);
    const update = JSON.parse(await runCli(["draft", "new"], projectRoot));
    await writeFile(join(projectRoot, update.artifacts.source), "Original source.");
    await writeFile(join(projectRoot, update.artifacts.document), "# Current document\n\nUpdated version.");
    await writeFile(join(projectRoot, update.artifacts.metadata), JSON.stringify(metadata));
    const sealed = JSON.parse(await runCli(["draft", "seal", "--id", update.draft_id, "--file", "docs/memory/auth.md"], projectRoot));
    expect(sealed).toMatchObject({ result: "draft_ready", replaces_managed_document: true });

    await expect(runCli(["document", "add", "--draft", update.draft_id], projectRoot)).rejects.toThrow("document add requires --replace");

    const updated = JSON.parse(await runCli(["document", "add", "--draft", update.draft_id, "--replace"], projectRoot));
    expect(updated).toMatchObject({ file_path: "docs/memory/auth.md", operation: "updated" });
  });

  it("recalls, physically deletes, and reports current document status", async () => {
    const projectRoot = await makeRoot();
    await runCli(["init"], projectRoot);
    const draft = await sealDraft(projectRoot, "cli.md", {
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
    const record = JSON.parse(await runCli(["document", "add", "--draft", draft.draft_id], projectRoot));

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
    await expect(access(join(projectRoot, "docnexus/library/cli.md"))).rejects.toThrow();
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

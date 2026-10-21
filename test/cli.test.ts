import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isDirectCliInvocation, runCli } from "../src/cli.js";
import { upsertManagedDocument } from "../src/managed-documents.js";
import { initializeProject } from "../src/project.js";
import type { DocNexusMetadata } from "../src/types.js";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-cli-"));
  tempRoots.push(root);
  return root;
}

const metadata: DocNexusMetadata = {
  title: "CLI Document",
  summary: "CLI document input provides current managed context for literal document lookup.",
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

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runCli", () => {
  it("refreshes the metadata contract with outdated workspace skills", async () => {
    const projectRoot = await makeRoot();
    await runCli(["init"], projectRoot);
    await writeFile(join(projectRoot, ".docnexus/skills/.docnexus-skills.json"), JSON.stringify({ version: "0.6.0" }));
    await writeFile(join(projectRoot, ".docnexus/schemas/metadata.schema.json"), "{}");
    await runCli(["document", "list"], projectRoot);
    const schema = JSON.parse(await readFile(join(projectRoot, ".docnexus/schemas/metadata.schema.json"), "utf8"));
    expect(schema.optionalFields["facts[]"].valid_from).toContain("ISO 8601");
  });
  it("initializes the current project through the CLI", async () => {
    const projectRoot = await makeRoot();

    const output = JSON.parse(await runCli(["init"], projectRoot));

    expect(output).toMatchObject({ project_root: projectRoot, initialized: true, created: true, links: [] });
    await expect(stat(join(projectRoot, ".docnexus", "project.json"))).resolves.toBeDefined();
    await expect(stat(join(projectRoot, ".docnexus", "skills", "docnexus", "SKILL.md"))).resolves.toBeDefined();
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
    await expect(stat(join(projectRoot, ".docnexus", "project.json"))).resolves.toBeDefined();
  });

  it("rejects project data commands before initialization", async () => {
    const projectRoot = await makeRoot();

    await expect(runCli(["index", "status"], projectRoot)).rejects.toThrow("Run \"docnexus init\"");
    await expect(stat(join(projectRoot, "docnexus"))).rejects.toThrow();
  });

  it("rejects removed commands", async () => {
    const projectRoot = await makeRoot();
    await initializeProject(projectRoot);
    for (const command of [["mcp"], ["graph", "unknown"], ["embeddings", "unknown"]]) {
      await expect(runCli(command, projectRoot)).rejects.toThrow("Unknown command");
    }
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
      .toEqual({ id: saved.id, record_version: expect.stringMatching(/^[a-f0-9]{64}$/), file_path: "docs/memory/read.md", metadata });
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
      timeline_path: expect.stringContaining("timeline.md")
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
    await writeFile(join(projectRoot, draft.artifacts.metadata), JSON.stringify({ ...metadata, title: "" }));
    await expect(runCli(["draft", "seal", "--id", draft.draft_id, "--file", "a.md"], projectRoot)).rejects.toThrow("title must be a non-empty string");
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
    const saved = JSON.parse(await runCli(["document", "add", "--draft", initial.draft_id], projectRoot));
    const current = JSON.parse(await runCli(["document", "get", "--id", saved.id], projectRoot));
    const update = JSON.parse(await runCli(["draft", "new"], projectRoot));
    await writeFile(join(projectRoot, update.artifacts.source), "Original source.");
    await writeFile(join(projectRoot, update.artifacts.document), "# Current document\n\nUpdated version.");
    await writeFile(join(projectRoot, update.artifacts.metadata), JSON.stringify(metadata));
    const sealed = JSON.parse(await runCli(["draft", "seal", "--id", update.draft_id, "--file", "docs/memory/auth.md", "--base-version", current.record_version], projectRoot));
    expect(sealed).toMatchObject({ result: "draft_ready", replaces_managed_document: true });

    await expect(runCli(["document", "add", "--draft", update.draft_id], projectRoot)).rejects.toThrow("document add requires --replace");

    const updated = JSON.parse(await runCli(["document", "add", "--draft", update.draft_id, "--replace"], projectRoot));
    expect(updated).toMatchObject({ file_path: "docs/memory/auth.md", operation: "updated" });
  });

  it("prints usage for unknown commands", async () => {
    const projectRoot = await makeRoot();

    await expect(runCli(["unknown"], projectRoot)).rejects.toThrow("Unknown command");
    // Inherited object keys must not resolve as commands or subcommands.
    await expect(runCli(["constructor"], projectRoot)).rejects.toThrow("Unknown command");
    await runCli(["init"], projectRoot);
    await expect(runCli(["draft", "toString"], projectRoot)).rejects.toThrow("Unknown command");
    await expect(runCli(["document"], projectRoot)).rejects.toThrow("Unknown command");
  });

  it("removes standalone index mutations and guards destructive document commands", async () => {
    const projectRoot = await makeRoot();
    await runCli(["init"], projectRoot);

    await expect(runCli(["index", "upsert", "memory.md"], projectRoot)).rejects.toThrow("Unknown command");
    await expect(runCli(["index", "delete", "--file", "memory.md"], projectRoot)).rejects.toThrow("Unknown command");
    await expect(runCli(["document", "delete", "--file", "memory.md"], projectRoot)).rejects.toThrow("--force");
    await expect(runCli(["reset"], projectRoot)).rejects.toThrow("--force");
  });
  it("finds a document, reads full current knowledge and history, adopts edits and deletes it", async () => {
    const projectRoot = await makeRoot();
    await runCli(["init", "--agent", "codex"], projectRoot);
    const draft = await sealDraft(projectRoot, "auth.md", { source: "User chose hourly rotation.", document: "# Auth\n\nTokens rotate hourly." });
    const added = JSON.parse(await runCli(["document", "add", "--draft", draft.draft_id], projectRoot));
    const found = JSON.parse(await runCli(["search", "rotate hourly"], projectRoot));
    expect(found.results[0]).toMatchObject({ id: added.id, library_path: "docnexus/library/auth.md", line: 3 });
    const recalled = JSON.parse(await runCli(["recall", "rotate hourly"], projectRoot));
    expect(recalled.results[0].document_ref.document_id).toBe(added.id);
    expect(recalled.context_groups[0].document.path).toBe("auth.md");
    const read = JSON.parse(await runCli(["document", "get", "--id", added.id, "--include", "document,timeline"], projectRoot));
    expect(read.document).toContain("Tokens rotate hourly");
    expect(read.timeline).toContain("User chose hourly rotation");
    await expect(stat(join(projectRoot, ".docnexus/store/brain.pglite"))).resolves.toBeDefined();
    await writeFile(join(projectRoot, "docnexus/library/auth.md"), "# Auth\n\nTokens rotate per use.");
    expect(JSON.parse(await runCli(["status"], projectRoot)).records.edited).toEqual([added.id]);
    await runCli(["document", "sync", "--id", added.id], projectRoot);
    expect(JSON.parse(await runCli(["search", "per use"], projectRoot)).results[0].id).toBe(added.id);
    expect(JSON.parse(await runCli(["index", "sync"], projectRoot))).toMatchObject({ result: "completed", rebuilt_documents: 1 });
    expect(JSON.parse(await runCli(["doctor"], projectRoot)).result).toBe("ok");
    await runCli(["document", "delete", "--id", added.id, "--force"], projectRoot);
    expect(JSON.parse(await runCli(["search", "rotate"], projectRoot)).results).toEqual([]);
    await expect(access(join(projectRoot, "docnexus/records", added.id))).rejects.toThrow();
  });

  it("validates search limits and document includes", async () => {
    const projectRoot = await makeRoot();
    await runCli(["init"], projectRoot);
    await expect(runCli(["search", "x", "--limit", "0"], projectRoot)).rejects.toThrow("positive integer");
    await expect(runCli(["search", "x", "--limit", "NaN"], projectRoot)).rejects.toThrow("positive integer");
    await expect(runCli(["search"], projectRoot)).rejects.toThrow("non-empty");
    await expect(runCli(["document", "get", "--id", "doc_0000000000000000", "--include", "chunks"], projectRoot)).rejects.toThrow("--include");
  });

  it("exposes graph maintenance and requires force for repairs and full rebuilds", async () => {
    const projectRoot = await makeRoot();
    await runCli(["init"], projectRoot);
    await runCli(["index", "sync"], projectRoot);
    expect(JSON.parse(await runCli(["graph", "audit"], projectRoot)).result).toBe("clean");
    await expect(runCli(["graph", "repair"], projectRoot)).rejects.toThrow("--force");
    await expect(runCli(["index", "rebuild"], projectRoot)).rejects.toThrow("--force");
    expect(JSON.parse(await runCli(["graph", "repair", "--force"], projectRoot)).actions.rebuilt_vector_index).toBe(false);
    expect(JSON.parse(await runCli(["index", "rebuild", "--force"], projectRoot)).result).toBe("completed");
    await expect(runCli(["embeddings", "install"], projectRoot)).rejects.toThrow("--from");
  });

});

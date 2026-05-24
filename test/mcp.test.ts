import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { callTool, runMcpServer } from "../src/mcp.js";
import { initializeProject } from "../src/project.js";

const tempRoots: string[] = [];
const previousEmbedder = process.env.DOCNEXUS_EMBEDDER;

const metadata = {
  title: "MCP Contract",
  summary: "The MCP layer archives already-refined Agent content and returns durable record paths and hashes.",
  tags: ["mcp"],
  entities: [],
  relationships: []
};

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-mcp-"));
  tempRoots.push(root);
  return root;
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

describe("callTool", () => {
  it("creates an immediately indexed current document", async () => {
    const projectRoot = await makeRoot();
    await initializeProject(projectRoot);

    const archived = await callTool("archive_record", {
      project_root: projectRoot,
      file_path: "docs/memory/mcp.md",
      source: "source",
      document: "document",
      metadata
    });

    expect(archived).toMatchObject({
      id: expect.stringMatching(/^doc_/),
      file_path: "docs/memory/mcp.md",
      operation: "created",
      chunk_count: 1
    });
  });

  it("gets only requested source and metadata assets", async () => {
    const projectRoot = await makeRoot();
    await initializeProject(projectRoot);
    const archived = await callTool("archive_record", {
      project_root: projectRoot,
      file_path: "docs/memory/mcp.md",
      source: "source",
      document: "document",
      metadata
    });

    const read = await callTool("get_record", {
      project_root: projectRoot,
      id: archived.id,
      include: ["source", "metadata"]
    });

    expect(read).toEqual({
      id: archived.id,
      file_path: "docs/memory/mcp.md",
      source: "source",
      metadata
    });
  });

  it("validates metadata without archiving", async () => {
    const projectRoot = await makeRoot();
    await initializeProject(projectRoot);

    await expect(callTool("validate_metadata", { project_root: projectRoot, metadata })).resolves.toEqual({
      valid: true,
      errors: []
    });
  });

  it("rejects fractional list limits before querying records", async () => {
    const projectRoot = await makeRoot();
    await initializeProject(projectRoot);

    await expect(callTool("list_records", { project_root: projectRoot, limit: 1.5 })).rejects.toThrow(
      "limit must be a positive integer"
    );
  });

  it("rejects unknown tools", async () => {
    await expect(callTool("missing_tool", {})).rejects.toThrow("Unknown tool: missing_tool");
  });

  it("physically deletes a current document through MCP handlers with confirmation", async () => {
    const projectRoot = await makeRoot();
    await initializeProject(projectRoot);
    const indexed = await callTool("archive_record", {
      project_root: projectRoot,
      file_path: "memory.md",
      source: "Agent memory recall through local chunks.",
      document: "Agent memory recall through local chunks.",
      metadata
    });
    expect(indexed).toMatchObject({
      file_path: "memory.md",
      operation: "created",
      chunk_count: 1
    });

    await expect(callTool("delete_document", { project_root: projectRoot, id: indexed.id })).rejects.toThrow();
    const deleted = await callTool("delete_document", { project_root: projectRoot, id: indexed.id, confirm: true });
    expect(deleted).toEqual({
      id: indexed.id,
      file_path: "memory.md",
      deleted: true
    });
  });

  it("reports index status through MCP handlers", async () => {
    const projectRoot = await makeRoot();
    await initializeProject(projectRoot);

    await expect(callTool("index_status", { project_root: projectRoot })).resolves.toMatchObject({
      document_count: 0,
      chunk_count: 0
    });
  });

  it("does not expose standalone index mutation tools", async () => {
    await expect(callTool("upsert_file_index", {})).rejects.toThrow("Unknown tool");
    await expect(callTool("delete_file_index", {})).rejects.toThrow("Unknown tool");
  });

  it("does not expose recall through MCP", async () => {
    await expect(callTool("recall", { query: "x", limit: 1 })).rejects.toThrow("Unknown tool: recall");
  });

  it("requires an absolute initialized project root for every MCP tool call", async () => {
    const projectRoot = await makeRoot();

    await expect(callTool("status", {})).rejects.toThrow("project_root is required");
    await expect(callTool("status", { project_root: "./relative-project" })).rejects.toThrow(
      "project_root must be an absolute path"
    );
    await expect(callTool("validate_metadata", { project_root: projectRoot, metadata })).rejects.toThrow(
      "Run \"docnexus init\""
    );
  });

  it("connects a global MCP server without binding a project at startup", async () => {
    let connected = false;

    await runMcpServer(async () => {
      connected = true;
    });

    expect(connected).toBe(true);
  });

  it("routes each request to its explicit initialized project without crossing records", async () => {
    const firstRoot = await makeRoot();
    const secondRoot = await makeRoot();
    await initializeProject(firstRoot);
    await initializeProject(secondRoot);

    await callTool("archive_record", {
      project_root: firstRoot,
      file_path: "first.md",
      source: "first source",
      document: "first document",
      metadata
    });
    await callTool("archive_record", {
      project_root: secondRoot,
      file_path: "second.md",
      source: "second source",
      document: "second document",
      metadata
    });

    const first = await callTool("list_records", { project_root: firstRoot });
    const second = await callTool("list_records", { project_root: secondRoot });

    expect(first.records).toHaveLength(1);
    expect(second.records).toHaveLength(1);
    expect(first.records[0].id).not.toBe(second.records[0].id);
  });
});

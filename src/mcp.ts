import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  getManagedIndexStatus,
  getManagedRecord,
  getManagedStatus,
  listManagedRecords,
  type ManagedRecordAsset
} from "./managed-documents.js";
import { validateMetadata } from "./metadata.js";
import { requireInitializedProject } from "./project.js";

type ToolArgs = Record<string, unknown>;
const knownTools = new Set([
  "list_records",
  "get_record",
  "status",
  "validate_metadata",
  "index_status"
]);

function asObject(value: unknown): ToolArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("tool arguments must be an object");
  }
  return value as ToolArgs;
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("include must be an array of strings");
  }
  return value;
}

function positiveInteger(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("limit must be a positive integer");
  }
  return value;
}

async function routeToolArgs(args: unknown): Promise<{ projectRoot: string; input: ToolArgs }> {
  const input = asObject(args);
  if (typeof input.project_root !== "string" || input.project_root.length === 0) {
    throw new Error("project_root is required");
  }
  if (!isAbsolute(input.project_root)) {
    throw new Error("project_root must be an absolute path");
  }
  const projectRoot = await requireInitializedProject(input.project_root);
  const { project_root: _projectRoot, ...toolInput } = input;
  return { projectRoot, input: toolInput };
}

export async function callTool(name: string, args: unknown): Promise<any> {
  if (!knownTools.has(name)) {
    throw new Error(`Unknown tool: ${name}`);
  }
  const { projectRoot, input } = await routeToolArgs(args);

  switch (name) {
    case "list_records":
      return listManagedRecords(projectRoot, {
        limit: positiveInteger(input.limit),
        tag: typeof input.tag === "string" ? input.tag : undefined
      });
    case "get_record":
      if (typeof input.id !== "string") {
        throw new Error("id must be a string");
      }
      return getManagedRecord(projectRoot, input.id, stringArray(input.include) as ManagedRecordAsset[] | undefined);
    case "status":
      return getManagedStatus(projectRoot);
    case "validate_metadata":
      return validateMetadata(input.metadata);
    case "index_status":
      return getManagedIndexStatus(projectRoot);
  }
}

function toolResponse(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

const projectRootSchema = {
  project_root: z.string().min(1)
};

export function createServer(): McpServer {
  const server = new McpServer({
    name: "docnexus",
    version: "0.1.0"
  });

  server.tool(
    "list_records",
    {
      ...projectRootSchema,
      limit: z.number().int().positive().optional(),
      tag: z.string().optional()
    },
    async (args) => toolResponse(await callTool("list_records", args))
  );

  server.tool(
    "get_record",
    {
      ...projectRootSchema,
      id: z.string(),
      include: z.array(z.enum(["source", "document", "metadata"])).optional()
    },
    async (args) => toolResponse(await callTool("get_record", args))
  );

  server.tool("status", projectRootSchema, async (args) => toolResponse(await callTool("status", args)));

  server.tool(
    "validate_metadata",
    {
      ...projectRootSchema,
      metadata: z.record(z.string(), z.unknown())
    },
    async (args) => toolResponse(await callTool("validate_metadata", args))
  );

  server.tool("index_status", projectRootSchema, async (args) => toolResponse(await callTool("index_status", args)));

  return server;
}

type ConnectServer = (server: McpServer) => Promise<void>;

const connectStdio: ConnectServer = async (server) => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

export async function runMcpServer(connect: ConnectServer = connectStdio): Promise<void> {
  await connect(createServer());
}

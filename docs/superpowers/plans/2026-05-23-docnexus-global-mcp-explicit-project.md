# DocNexus Global MCP With Explicit Project Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-project MCP startup binding with one stateless MCP entry whose every tool call explicitly supplies an initialized project's absolute `project_root`.

**Architecture:** Keep `.docnexus/` storage, CLI data commands, and recall behavior unchanged. Refactor the MCP boundary so the server has no bound project state: a shared dispatcher validates and removes `project_root` on each tool call, then invokes the existing project-root-aware services. Update the capture skill and public documentation to pass and explain that routing context.

**Tech Stack:** TypeScript, Node.js ESM, MCP SDK, Zod, Vitest, npm package documentation.

---

## File Map

- Modify `test/mcp.test.ts`: lock in explicit per-call project routing, absolute-path validation, initialized-project validation, and cross-project isolation in one server contract.
- Modify `src/mcp.ts`: make MCP server stateless and route each registered tool through a common explicit-project dispatcher.
- Modify `test/cli.test.ts`: specify global MCP startup syntax and removal of the old bound-project launch form.
- Modify `src/cli.ts`: make `docnexus mcp` valid only without project arguments.
- Modify `src/index.ts`: start the same global stateless MCP service when using the source entrypoint.
- Modify `skills/docnexus-capture/SKILL.md`: require absolute `project_root` in its MCP metadata/archive calls.
- Modify `README.md`, `README.zh-CN.md`, `docs/product-brief-docnexus-mvp.md`, `docs/product-brief-docnexus-mvp.en.md`, and `docs/product-brief-docnexus-mvp.zh-CN.md`: document one-time MCP registration and per-tool explicit project context.

### Task 1: Specify The Stateless MCP Tool Contract

**Files:**
- Modify: `test/mcp.test.ts`

- [ ] **Step 1: Rewrite MCP handler calls so the tool input carries its target project**

Change existing known-tool calls from a bound-root signature such as:

```ts
const archived = await callTool(projectRoot, "archive_record", {
  source: "source",
  document: "document",
  metadata
});
```

to the new tool-call contract:

```ts
const archived = await callTool("archive_record", {
  project_root: projectRoot,
  source: "source",
  document: "document",
  metadata
});
```

Apply the same `project_root` argument to `get_record`, `validate_metadata`, `list_records`, `upsert_file_index`, `delete_file_index`, and `index_status`. Initialize `projectRoot` before the `validate_metadata` case because validation now requires a mounted DocNexus project.

- [ ] **Step 2: Replace fixed-startup assertions with explicit request validation tests**

Replace the tests that assert startup binds an initialized project with:

```ts
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
```

- [ ] **Step 3: Add a single-server cross-project isolation contract**

Add a test that creates two initialized roots and performs calls through the same stateless dispatch API:

```ts
it("routes each request to its explicit initialized project without crossing records", async () => {
  const firstRoot = await makeRoot();
  const secondRoot = await makeRoot();
  await initializeProject(firstRoot);
  await initializeProject(secondRoot);

  await callTool("archive_record", {
    project_root: firstRoot,
    source: "first source",
    document: "first document",
    metadata
  });
  await callTool("archive_record", {
    project_root: secondRoot,
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
```

- [ ] **Step 4: Run the focused test and verify it fails against the bound-project implementation**

Run:

```bash
npm test -- test/mcp.test.ts
```

Expected: FAIL because `callTool` and `runMcpServer` still require a startup-bound `projectRoot`, and tool input routing is not implemented.

### Task 2: Implement Explicit Project Routing In MCP

**Files:**
- Modify: `src/mcp.ts`
- Test: `test/mcp.test.ts`

- [ ] **Step 1: Add centralized project-context parsing and validation**

Import absolute-path detection and create a shared input router:

```ts
import { isAbsolute } from "node:path";

interface RoutedToolArgs {
  projectRoot: string;
  input: ToolArgs;
}

async function routeToolArgs(args: unknown): Promise<RoutedToolArgs> {
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
```

This is the only new routing abstraction: it prevents every tool case from repeating the same path and initialization checks.

- [ ] **Step 2: Change `callTool` so known operations validate per-call routing context**

Use a stateless public signature and preserve unknown-tool rejection:

```ts
export async function callTool(name: string, args: unknown): Promise<any> {
  if (![
    "archive_record",
    "list_records",
    "get_record",
    "status",
    "validate_metadata",
    "upsert_file_index",
    "delete_file_index",
    "index_status"
  ].includes(name)) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const { projectRoot, input } = await routeToolArgs(args);

  switch (name) {
    case "archive_record":
      return archiveRecord(projectRoot, input as unknown as ArchiveRecordInput);
    case "list_records":
      return listRecords(projectRoot, {
        limit: positiveInteger(input.limit),
        tag: typeof input.tag === "string" ? input.tag : undefined
      });
    case "get_record":
      if (typeof input.id !== "string") {
        throw new Error("id must be a string");
      }
      return getRecord(projectRoot, input.id, stringArray(input.include) as RecordAsset[] | undefined);
    case "status":
      return getStatus(projectRoot);
    case "validate_metadata":
      return validateMetadata(input.metadata);
    case "upsert_file_index":
      if (typeof input.file_path !== "string") {
        throw new Error("file_path is required");
      }
      return upsertFileIndex(projectRoot, {
        file_path: input.file_path,
        file_name: optionalString(input.file_name, "file_name"),
        record_id: optionalString(input.record_id, "record_id")
      });
    case "delete_file_index":
      return deleteFileIndex(projectRoot, {
        file_path: optionalString(input.file_path, "file_path"),
        file_id: optionalString(input.file_id, "file_id")
      });
    case "index_status":
      return getIndexStatus(projectRoot);
  }
}
```

Keep `recall` outside the known tool list, so it remains rejected without requiring routing context.

- [ ] **Step 3: Add `project_root` to every MCP tool schema and remove bound state**

Introduce one shared Zod field spread into every server tool:

```ts
const projectRootSchema = {
  project_root: z.string().min(1)
};

export function createServer(): McpServer {
  const server = new McpServer({ name: "docnexus", version: "0.1.0" });

  server.tool(
    "archive_record",
    {
      ...projectRootSchema,
      source: z.string().min(1),
      document: z.string().min(1),
      metadata: z.record(z.string(), z.unknown()),
      source_name: z.string().optional()
    },
    async (args) => toolResponse(await callTool("archive_record", args))
  );

  server.tool("status", projectRootSchema, async (args) => toolResponse(await callTool("status", args)));

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

  server.tool(
    "validate_metadata",
    {
      ...projectRootSchema,
      metadata: z.record(z.string(), z.unknown())
    },
    async (args) => toolResponse(await callTool("validate_metadata", args))
  );

  server.tool(
    "upsert_file_index",
    {
      ...projectRootSchema,
      file_path: z.string().min(1),
      file_name: z.string().optional(),
      record_id: z.string().optional()
    },
    async (args) => toolResponse(await callTool("upsert_file_index", args))
  );

  server.tool(
    "delete_file_index",
    {
      ...projectRootSchema,
      file_path: z.string().optional(),
      file_id: z.string().optional()
    },
    async (args) => toolResponse(await callTool("delete_file_index", args))
  );

  server.tool("index_status", projectRootSchema, async (args) => toolResponse(await callTool("index_status", args)));

  return server;
}
```

Change startup to connect without project validation:

```ts
export async function runMcpServer(connect: ConnectServer = connectStdio): Promise<void> {
  await connect(createServer());
}
```

- [ ] **Step 4: Run the MCP test and verify the new contract passes**

Run:

```bash
npm test -- test/mcp.test.ts
```

Expected: PASS, with tools requiring explicit initialized absolute project roots while startup itself no longer selects a project.

- [ ] **Step 5: Commit the MCP protocol implementation**

```bash
git add test/mcp.test.ts src/mcp.ts
git commit -m "feat: route MCP calls through explicit projects"
```

### Task 3: Replace Per-Project MCP Startup Syntax

**Files:**
- Modify: `test/cli.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing CLI startup contract test**

Replace the test for `resolveMcpProjectRoot` with a test of a global startup argument validator:

```ts
import { validateMcpInvocation, runCli, type RunCliDependencies } from "../src/cli.js";

it("accepts only the global MCP startup form", () => {
  expect(() => validateMcpInvocation(["mcp"])).not.toThrow();
  expect(() => validateMcpInvocation(["mcp", "--project-root", "/tmp/project"])).toThrow(
    "Usage: docnexus mcp"
  );
});
```

- [ ] **Step 2: Run the focused CLI test and verify it fails**

Run:

```bash
npm test -- test/cli.test.ts
```

Expected: FAIL because `validateMcpInvocation` does not exist and current startup requires `--project-root`.

- [ ] **Step 3: Implement global MCP startup validation and routing**

Replace project-root resolution with strict zero-argument MCP validation:

```ts
export function validateMcpInvocation(argv: string[]): void {
  if (argv.length !== 1 || argv[0] !== "mcp") {
    throw new Error("Usage: docnexus mcp");
  }
}

export async function runMain(argv: string[], cwd = process.cwd()): Promise<void> {
  if (argv[0] === "mcp") {
    validateMcpInvocation(argv);
    await runMcpServer();
    return;
  }
  process.stdout.write(await runCli(argv, cwd));
}
```

Update the source MCP entrypoint to start the same unbound service:

```ts
#!/usr/bin/env node
import { runMcpServer } from "./mcp.js";

if (process.argv.slice(2).length !== 0) {
  throw new Error("Usage: docnexus mcp");
}

await runMcpServer();
```

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
npm test -- test/cli.test.ts test/mcp.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the global startup form**

```bash
git add test/cli.test.ts src/cli.ts src/index.ts
git commit -m "feat: expose one global MCP startup entry"
```

### Task 4: Adapt The Bundled Capture Skill

**Files:**
- Modify: `skills/docnexus-capture/SKILL.md`

- [ ] **Step 1: Update the MCP prerequisite and call instructions**

Replace the fixed-server wording with explicit current-project routing guidance:

```markdown
The MCP server is configured once globally. Before invoking MCP tools, determine the initialized target project's absolute path. Every MCP call in this skill must include that path as `project_root`. If MCP reports that the project is not initialized, instruct the user to run `docnexus init` in that project before archiving.
```

Update workflow calls to state their required routed payload:

```markdown
5. Call the DocNexus MCP `validate_metadata` tool with `project_root` and `metadata`.
...
8. Call the DocNexus MCP `archive_record` tool with `project_root`, `source`, `document`, and `metadata`.
```

- [ ] **Step 2: Verify the skill no longer instructs fixed MCP project configuration**

Run:

```bash
rg -n "configured for the initialized target project|validate_metadata|archive_record|project_root" skills/docnexus-capture/SKILL.md
```

Expected: no fixed-server wording; both MCP call instructions include `project_root`.

- [ ] **Step 3: Commit the capture skill protocol update**

```bash
git add skills/docnexus-capture/SKILL.md
git commit -m "docs: route capture skill MCP calls by project"
```

### Task 5: Update Public English And Chinese Usage Documentation

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/product-brief-docnexus-mvp.md`
- Modify: `docs/product-brief-docnexus-mvp.en.md`
- Modify: `docs/product-brief-docnexus-mvp.zh-CN.md`

- [ ] **Step 1: Update README MCP registration and tool contract examples**

Replace per-project registration text with one registration example:

```bash
codex mcp add docnexus -- docnexus mcp
claude mcp add --transport stdio docnexus -- docnexus mcp
```

Use corresponding configuration arguments:

```toml
[mcp_servers.docnexus]
command = "docnexus"
args = ["mcp"]
```

```json
{
  "mcpServers": {
    "docnexus": {
      "command": "docnexus",
      "args": ["mcp"]
    }
  }
}
```

Directly below the tool list, document that every MCP tool call includes an initialized project's absolute path, for example:

```json
{
  "project_root": "/absolute/path/to/your-project",
  "source": "conversation",
  "document": "Refined memory document",
  "metadata": {}
}
```

Update source development startup to:

```bash
node dist/src/cli.js mcp
```

- [ ] **Step 2: Update product briefs to match the new responsibility boundary**

In all brief variants, replace the startup-bound isolation statement with:

```markdown
- Isolation: each project stores data in its own `.docnexus/` domain; a globally configured MCP server routes every tool invocation through its required absolute `project_root`.
```

Update the MCP responsibility bullets to state that operations validate the explicit initialized project supplied in each call. Replace command examples with:

```bash
docnexus mcp
```

- [ ] **Step 3: Run a focused documentation search**

Run:

```bash
rg -n "mcp --project-root|bound to one initialized project|绑定一个已初始化项目|每个需要被智能体访问的已初始化项目|Register one MCP entry for each" README.md README.zh-CN.md docs/product-brief-docnexus-mvp.md docs/product-brief-docnexus-mvp.en.md docs/product-brief-docnexus-mvp.zh-CN.md skills/docnexus-capture/SKILL.md
```

Expected: no matches.

- [ ] **Step 4: Commit user-facing documentation**

```bash
git add README.md README.zh-CN.md docs/product-brief-docnexus-mvp.md docs/product-brief-docnexus-mvp.en.md docs/product-brief-docnexus-mvp.zh-CN.md
git commit -m "docs: describe global MCP project routing"
```

### Task 6: Verify The Complete Change

**Files:**
- Verify only: all files changed by Tasks 1-5

- [ ] **Step 1: Run the full automated suite**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected: all commands PASS.

- [ ] **Step 2: Run graph/index integration coverage using the local deterministic embedder configuration**

Run:

```bash
DOCNEXUS_LADYBUG_INTEGRATION=1 npm test -- test/mcp.test.ts test/cli.test.ts test/ladybug-store.test.ts
```

Expected: PASS, confirming MCP index operations remain isolated and compatible with LadybugDB.

- [ ] **Step 3: Verify package contents and published entrypoint**

Run:

```bash
npm pack --dry-run
```

Expected: PASS; tarball output includes `dist/src/cli.js`, `skills/docnexus-capture/SKILL.md`, `README.md`, and `README.zh-CN.md`.

- [ ] **Step 4: Run diff hygiene checks and confirm only intended dirty state remains**

Run:

```bash
git diff --check
git status --short --branch
```

Expected: no whitespace errors; only any pre-existing unrelated `.swp` deletion remains outside the implementation commits.

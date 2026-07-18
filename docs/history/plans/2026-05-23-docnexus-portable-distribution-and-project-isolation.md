# DocNexus Portable Distribution and Project Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distribute DocNexus through a short `docnexus` executable while requiring explicit, isolated initialization of every managed project before CLI or MCP data access.

**Architecture:** Add a focused project-domain module that creates and validates `.docnexus/project.json`, then enforce that boundary at the public CLI and MCP startup paths. Keep existing storage and retrieval internals intact, add a packaged skill installer, and expose the complete runtime through `@docnexus/docnexus` with portable user documentation.

**Tech Stack:** TypeScript, Node.js ESM and `node:sqlite`, Vitest, MCP stdio SDK, LadybugDB, npm package metadata, Markdown skills/documentation.

---

## File Structure

- Create `src/project.ts`: own project-root resolution, `.docnexus/project.json` creation, initialization checks, and non-destructive adoption of existing stores.
- Create `test/project.test.ts`: unit coverage for initialization markers, idempotence, legacy store adoption, and invalid marker/root failures.
- Modify `src/store.ts`: expose the existing archive schema setup function so explicit initialization can establish the SQLite archive tables.
- Modify `src/cli.ts`: parse global `--project-root`, add `init` and `skills install`, validate initialized projects before data commands, and dispatch `mcp`.
- Modify `test/cli.test.ts`: initialize CLI test projects, cover root overrides and uninitialized-command rejection, and preserve existing Graph RAG behavior assertions.
- Modify `src/mcp.ts`: reject MCP server startup unless its provided root is initialized; retain tools closed over one fixed root.
- Modify `test/mcp.test.ts`: initialize data-bearing MCP fixtures and test startup root validation without changing the existing tool contract.
- Create `src/skills-install.ts`: copy packaged `docnexus-capture` and `docnexus-recall` skill directories to Codex or Claude project/user destinations.
- Create `test/skills-install.test.ts`: test destination mapping, copied contents, initialization requirements, and invalid target/scope inputs.
- Modify `package.json` and `package-lock.json`: adopt the scoped package name, publishable file list, `docnexus` binary, and package-build verification.
- Modify `skills/docnexus-recall/SKILL.md` and `skills/docnexus-capture/SKILL.md`: use installed executable wording and the initialized-project prerequisite.
- Modify `README.md`, `README.zh-CN.md`, `docs/product-brief-docnexus-mvp.md`, `docs/product-brief-docnexus-mvp.en.md`, and `docs/product-brief-docnexus-mvp.zh-CN.md`: replace local source-path setup with npm/global-install, manual skills/MCP setup, and per-project isolation documentation.

Internal store, file-index, LadybugDB, graph-maintenance, and recall functions remain usable in focused unit tests. The initialized-project boundary is enforced at the user-facing CLI and MCP server startup surfaces; this avoids refactoring retrieval algorithms or changing the grouped recall JSON protocol.

### Task 1: Explicit Project Initialization Domain

**Files:**
- Create: `src/project.ts`
- Create: `test/project.test.ts`
- Modify: `src/store.ts`

- [ ] **Step 1: Write failing tests for initialization, adoption, and marker validation**

Create `test/project.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeProject,
  projectMarkerPath,
  requireInitializedProject
} from "../src/project.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-project-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project initialization", () => {
  it("initializes a project with a versioned marker and store layout", async () => {
    const root = await makeRoot();

    const result = await initializeProject(root);
    const marker = JSON.parse(await readFile(projectMarkerPath(root), "utf8"));

    expect(result).toEqual({ project_root: root, initialized: true, adopted_existing_store: false });
    expect(marker).toMatchObject({ format_version: 1, initialized_at: expect.any(String) });
    await expect(stat(join(root, ".docnexus", "index.sqlite"))).resolves.toBeDefined();
  });

  it("is idempotent and preserves existing project data", async () => {
    const root = await makeRoot();
    await initializeProject(root);
    const sentinel = join(root, ".docnexus", "records", "keep.md");
    await writeFile(sentinel, "existing data");
    const before = await readFile(projectMarkerPath(root), "utf8");

    await initializeProject(root);

    await expect(readFile(sentinel, "utf8")).resolves.toBe("existing data");
    await expect(readFile(projectMarkerPath(root), "utf8")).resolves.toBe(before);
  });

  it("adopts an existing pre-marker store without deleting its contents", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".docnexus", "records"), { recursive: true });
    await writeFile(join(root, ".docnexus", "records", "legacy.md"), "legacy");

    await expect(initializeProject(root)).resolves.toMatchObject({ adopted_existing_store: true });
    await expect(readFile(join(root, ".docnexus", "records", "legacy.md"), "utf8")).resolves.toBe("legacy");
    await expect(requireInitializedProject(root)).resolves.toBe(root);
  });

  it("rejects unsupported markers and non-existent project roots", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".docnexus"), { recursive: true });
    await writeFile(projectMarkerPath(root), JSON.stringify({ format_version: 99, initialized_at: "x" }));

    await expect(requireInitializedProject(root)).rejects.toThrow("unsupported DocNexus project format");
    await expect(initializeProject(join(root, "missing"))).rejects.toThrow("project root does not exist");
  });
});
```

- [ ] **Step 2: Run the project test and verify it fails because the module does not exist**

Run:

```bash
npm test -- test/project.test.ts
```

Expected: FAIL because `../src/project.js` cannot be resolved.

- [ ] **Step 3: Export non-destructive archive schema initialization**

In `src/store.ts`, rename the private setup function and keep archive behavior routed through it:

```ts
export async function ensureArchiveStore(projectRoot: string): Promise<void> {
  await mkdir(recordsPath(projectRoot), { recursive: true });
  await mkdir(schemasPath(projectRoot), { recursive: true });
  await writeFile(join(schemasPath(projectRoot), "metadata.schema.json"), `${stableJson(metadataSchema)}\n`);

  const db = openDatabase(projectRoot);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        document_hash TEXT NOT NULL,
        metadata_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_path TEXT NOT NULL
      )
    `);
  } finally {
    db.close();
  }
}
```

Update `archiveRecord(...)` to call `await ensureArchiveStore(projectRoot);` instead of the prior private name. This uses `CREATE TABLE IF NOT EXISTS` and preserves existing records.

- [ ] **Step 4: Implement the versioned project domain module**

Create `src/project.ts`:

```ts
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ensureIndexStore } from "./file-index.js";
import { ensureArchiveStore, storePath } from "./store.js";

const PROJECT_FORMAT_VERSION = 1;

interface ProjectMarker {
  format_version: number;
  initialized_at: string;
}

export interface InitializeProjectOutput {
  project_root: string;
  initialized: true;
  adopted_existing_store: boolean;
}

export function projectMarkerPath(projectRoot: string): string {
  return join(storePath(projectRoot), "project.json");
}

async function assertProjectDirectory(projectRoot: string): Promise<string> {
  const root = resolve(projectRoot);
  const info = await stat(root).catch(() => undefined);
  if (!info) {
    throw new Error(`project root does not exist: ${root}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`project root is not a directory: ${root}`);
  }
  return root;
}

async function readMarker(projectRoot: string): Promise<ProjectMarker | undefined> {
  const content = await readFile(projectMarkerPath(projectRoot), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (content === undefined) {
    return undefined;
  }
  const marker = JSON.parse(content) as Partial<ProjectMarker>;
  if (marker.format_version !== PROJECT_FORMAT_VERSION || typeof marker.initialized_at !== "string") {
    throw new Error(`unsupported DocNexus project format at ${projectMarkerPath(projectRoot)}; migration is required`);
  }
  return marker as ProjectMarker;
}

export async function requireInitializedProject(projectRoot: string): Promise<string> {
  const root = await assertProjectDirectory(projectRoot);
  if (!(await readMarker(root))) {
    throw new Error(`DocNexus project is not initialized: ${root}. Run "docnexus init" in that project first.`);
  }
  return root;
}

export async function initializeProject(projectRoot: string): Promise<InitializeProjectOutput> {
  const root = await assertProjectDirectory(projectRoot);
  const marker = await readMarker(root);
  const existingStore = await access(storePath(root)).then(() => true).catch(() => false);
  if (marker) {
    return { project_root: root, initialized: true, adopted_existing_store: false };
  }

  await mkdir(storePath(root), { recursive: true });
  await ensureArchiveStore(root);
  await ensureIndexStore(root);
  await writeFile(
    projectMarkerPath(root),
    `${JSON.stringify({ format_version: PROJECT_FORMAT_VERSION, initialized_at: new Date().toISOString() }, null, 2)}\n`,
    { flag: "wx" }
  );
  return { project_root: root, initialized: true, adopted_existing_store: existingStore };
}
```

- [ ] **Step 5: Run the focused tests and verify initialization behavior passes**

Run:

```bash
npm test -- test/project.test.ts test/store.test.ts
```

Expected: PASS; existing direct store unit tests retain their current internal behavior.

- [ ] **Step 6: Commit the initialization domain**

```bash
git add src/project.ts src/store.ts test/project.test.ts
git commit -m "feat: add explicit project initialization"
```

### Task 2: CLI Project Binding and Data-Command Gate

**Files:**
- Modify: `src/cli.ts`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Add failing CLI tests for `init`, root overrides, and uninitialized rejection**

In `test/cli.test.ts`, import `stat` and add:

```ts
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
```

Update existing CLI data tests to call the explicit initialization boundary at the beginning of each project scenario:

```ts
await runCli(["init"], projectRoot);
```

Place it before `archiveRecord(...)`, `index ...`, `graph ...`, or `recall ...` calls for each test that exercises a data command. Unknown-command tests do not need initialization because invalid syntax should report usage before accessing data.

- [ ] **Step 2: Run the CLI test and verify the new command/gate tests fail**

Run:

```bash
npm test -- test/cli.test.ts
```

Expected: FAIL because `init` and `--project-root` are not recognized and existing data commands do not enforce initialization.

- [ ] **Step 3: Add global root parsing, initialization dispatch, and the data-command gate**

Modify `src/cli.ts` imports:

```ts
import { resolve } from "node:path";
import { initializeProject, requireInitializedProject } from "./project.js";
```

Add a small argument resolver:

```ts
function parseInvocation(argv: string[], cwd: string): { argv: string[]; projectRoot: string } {
  if (argv[0] !== "--project-root") {
    return { argv, projectRoot: resolve(cwd) };
  }
  const root = argv[1];
  if (!root || root.startsWith("--")) {
    throw new Error("--project-root requires a value");
  }
  return { argv: argv.slice(2), projectRoot: resolve(cwd, root) };
}
```

At the start of `runCli`, treat its existing `projectRoot` parameter as the invocation working directory, then gate recognized data commands:

```ts
export async function runCli(
  argv: string[],
  cwd = process.cwd(),
  dependencies: RunCliDependencies = defaultDependencies
): Promise<string> {
  const invocation = parseInvocation(argv, cwd);
  const [command, subcommand, ...rest] = invocation.argv;
  const projectRoot = invocation.projectRoot;

  if (command === "init") {
    return json(await initializeProject(projectRoot));
  }

  const isDataCommand =
    command === "index" ||
    command === "graph" ||
    command === "recall";
  if (isDataCommand) {
    await requireInitializedProject(projectRoot);
  }

  // Existing index, graph, and recall dispatch continues using projectRoot.
```

Keep the existing command handlers and output JSON intact. Extend usage output with:

```text
docnexus init
docnexus --project-root path/to/project init
```

- [ ] **Step 4: Run CLI coverage and verify it passes**

Run:

```bash
npm test -- test/cli.test.ts test/project.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit CLI initialization enforcement**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat: require initialized projects in CLI"
```

### Task 3: MCP Subcommand and Fixed Project Binding

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/mcp.ts`
- Modify: `src/index.ts`
- Modify: `test/mcp.test.ts`

- [ ] **Step 1: Add failing tests for MCP root validation**

In `test/mcp.test.ts`, import the new project initializer and `runMcpServer`:

```ts
import { initializeProject } from "../src/project.js";
import { callTool, runMcpServer } from "../src/mcp.js";
```

Change data-bearing handler tests to initialize their roots before the first tool operation:

```ts
await initializeProject(projectRoot);
```

Add a transport injection boundary test without opening stdio:

```ts
  it("rejects MCP startup for an uninitialized project before connecting transport", async () => {
    const projectRoot = await makeRoot();
    let connected = false;

    await expect(
      runMcpServer(projectRoot, async () => {
        connected = true;
      })
    ).rejects.toThrow("Run \"docnexus init\"");
    expect(connected).toBe(false);
  });

  it("connects MCP only after validating its fixed initialized project", async () => {
    const projectRoot = await makeRoot();
    await initializeProject(projectRoot);
    let connected = false;

    await runMcpServer(projectRoot, async () => {
      connected = true;
    });

    expect(connected).toBe(true);
  });
```

In `test/cli.test.ts`, import a new parser and add command-line contract tests:

```ts
import { resolveMcpProjectRoot } from "../src/cli.js";

it("requires an explicit MCP project-root option after the subcommand", () => {
  expect(() => resolveMcpProjectRoot(["mcp"], "/tmp")).toThrow("docnexus mcp --project-root");
  expect(resolveMcpProjectRoot(["mcp", "--project-root", "./project"], "/tmp")).toBe("/tmp/project");
});
```

- [ ] **Step 2: Run MCP and CLI tests and verify the new APIs fail**

Run:

```bash
npm test -- test/mcp.test.ts test/cli.test.ts
```

Expected: FAIL because MCP validation/connection injection and `resolveMcpProjectRoot(...)` are not implemented.

- [ ] **Step 3: Validate MCP startup before connecting transport**

Modify `src/mcp.ts`:

```ts
import { requireInitializedProject } from "./project.js";

type ConnectServer = (server: McpServer) => Promise<void>;

const connectStdio: ConnectServer = async (server) => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

export async function runMcpServer(projectRoot: string, connect: ConnectServer = connectStdio): Promise<void> {
  const boundRoot = await requireInitializedProject(projectRoot);
  const server = createServer(boundRoot);
  await connect(server);
}
```

The existing `createServer(projectRoot)` and `callTool(projectRoot, ...)` signatures stay unchanged: the server startup path provides their validated fixed root.

- [ ] **Step 4: Route `docnexus mcp --project-root` through the main executable**

Modify `src/cli.ts`:

```ts
import { resolve } from "node:path";
import { runMcpServer } from "./mcp.js";

export function resolveMcpProjectRoot(argv: string[], cwd = process.cwd()): string {
  if (argv[0] !== "mcp" || argv[1] !== "--project-root" || !argv[2] || argv.length !== 3) {
    throw new Error("Usage: docnexus mcp --project-root /path/to/project");
  }
  return resolve(cwd, argv[2]);
}

export async function runMain(argv: string[], cwd = process.cwd()): Promise<void> {
  if (argv[0] === "mcp") {
    await runMcpServer(resolveMcpProjectRoot(argv, cwd));
    return;
  }
  process.stdout.write(await runCli(argv, cwd));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMain(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
```

Remove the old direct `runCli(...).then(...)` executable block once `runMain(...)` replaces it.

Modify `src/index.ts` only as the development compatibility entrypoint:

```ts
#!/usr/bin/env node
import { resolveMcpProjectRoot } from "./cli.js";
import { runMcpServer } from "./mcp.js";

await runMcpServer(resolveMcpProjectRoot(["mcp", ...process.argv.slice(2)]));
```

This causes the legacy built MCP entrypoint to require `--project-root` as well; public package configuration will use `docnexus mcp`.

- [ ] **Step 5: Run MCP and CLI tests and verify fixed binding passes**

Run:

```bash
npm test -- test/mcp.test.ts test/cli.test.ts test/project.test.ts
```

Expected: PASS; MCP tests confirm validation happens before transport connection and tools remain bound through server construction.

- [ ] **Step 6: Commit MCP binding**

```bash
git add src/cli.ts src/mcp.ts src/index.ts test/mcp.test.ts test/cli.test.ts
git commit -m "feat: bind MCP startup to initialized project"
```

### Task 4: Packaged Skills Installer

**Files:**
- Create: `src/skills-install.ts`
- Create: `test/skills-install.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write failing tests for project and user skill installation**

Create `test/skills-install.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeProject } from "../src/project.js";
import { installSkills } from "../src/skills-install.js";

const roots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function makePackagedSkills(): Promise<string> {
  const root = await makeRoot("docnexus-skills-source-");
  for (const name of ["docnexus-capture", "docnexus-recall"]) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "SKILL.md"), `# ${name}\n`);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("installSkills", () => {
  it("installs both skills into an initialized Codex project by default", async () => {
    const projectRoot = await makeRoot("docnexus-skills-project-");
    const source = await makePackagedSkills();
    await initializeProject(projectRoot);

    const result = await installSkills({ target: "codex", projectRoot, packagedSkillsRoot: source });

    expect(result.destination).toBe(join(projectRoot, ".agents", "skills"));
    await expect(readFile(join(result.destination, "docnexus-recall", "SKILL.md"), "utf8")).resolves.toContain("docnexus-recall");
  });

  it("installs Claude skills into the project-specific Claude directory", async () => {
    const projectRoot = await makeRoot("docnexus-skills-project-");
    const source = await makePackagedSkills();
    await initializeProject(projectRoot);

    const result = await installSkills({ target: "claude", projectRoot, packagedSkillsRoot: source });

    expect(result.destination).toBe(join(projectRoot, ".claude", "skills"));
  });

  it("allows user scope without an initialized project", async () => {
    const source = await makePackagedSkills();
    const home = await makeRoot("docnexus-skills-home-");

    const codex = await installSkills({ target: "codex", scope: "user", homeDir: home, packagedSkillsRoot: source });
    const claude = await installSkills({ target: "claude", scope: "user", homeDir: home, packagedSkillsRoot: source });

    expect(codex.destination).toBe(join(home, ".agents", "skills"));
    expect(claude.destination).toBe(join(home, ".claude", "skills"));
  });

  it("rejects project installation before initialization and invalid options", async () => {
    const root = await makeRoot("docnexus-skills-project-");
    const source = await makePackagedSkills();

    await expect(installSkills({ target: "codex", projectRoot: root, packagedSkillsRoot: source })).rejects.toThrow("Run \"docnexus init\"");
    await expect(installSkills({ target: "cursor" as never, scope: "user", packagedSkillsRoot: source })).rejects.toThrow("target must be codex or claude");
  });
});
```

- [ ] **Step 2: Run the skills installer test and verify it fails because the module does not exist**

Run:

```bash
npm test -- test/skills-install.test.ts
```

Expected: FAIL because `../src/skills-install.js` cannot be resolved.

- [ ] **Step 3: Implement the focused skill copy service**

Create `src/skills-install.ts`:

```ts
import { cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireInitializedProject } from "./project.js";

type SkillsTarget = "codex" | "claude";
type SkillsScope = "project" | "user";

const SKILL_NAMES = ["docnexus-capture", "docnexus-recall"] as const;

export interface InstallSkillsInput {
  target: SkillsTarget;
  scope?: SkillsScope;
  projectRoot?: string;
  homeDir?: string;
  packagedSkillsRoot?: string;
}

export interface InstallSkillsOutput {
  target: SkillsTarget;
  scope: SkillsScope;
  destination: string;
  installed: readonly string[];
}

function bundledSkillsRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../skills");
}

export async function installSkills(input: InstallSkillsInput): Promise<InstallSkillsOutput> {
  if (input.target !== "codex" && input.target !== "claude") {
    throw new Error("target must be codex or claude");
  }
  const scope = input.scope ?? "project";
  if (scope !== "project" && scope !== "user") {
    throw new Error("scope must be project or user");
  }

  let destination: string;
  if (scope === "project") {
    if (!input.projectRoot) {
      throw new Error("project root is required for project-scoped skills");
    }
    const root = await requireInitializedProject(input.projectRoot);
    destination = join(root, input.target === "codex" ? ".agents" : ".claude", "skills");
  } else {
    destination = join(input.homeDir ?? homedir(), input.target === "codex" ? ".agents" : ".claude", "skills");
  }

  const source = input.packagedSkillsRoot ?? bundledSkillsRoot();
  await mkdir(destination, { recursive: true });
  for (const skill of SKILL_NAMES) {
    await cp(join(source, skill), join(destination, skill), { recursive: true, force: true });
  }
  return { target: input.target, scope, destination, installed: SKILL_NAMES };
}
```

- [ ] **Step 4: Dispatch skills installation from the CLI**

In `src/cli.ts`, import `installSkills` and add a handler before data-command validation:

```ts
import { installSkills } from "./skills-install.js";

if (command === "skills" && subcommand === "install") {
  const options = parseOptions(rest);
  const target = options.target;
  if (target !== "codex" && target !== "claude") {
    throw new Error("--target must be codex or claude");
  }
  const scope = options.scope ?? "project";
  if (scope !== "project" && scope !== "user") {
    throw new Error("--scope must be project or user");
  }
  return json(
    await installSkills({
      target,
      scope,
      projectRoot,
    })
  );
}
```

Extend usage output:

```text
docnexus skills install --target codex
docnexus skills install --target claude
docnexus skills install --target codex --scope user
```

Add to `test/cli.test.ts`:

```ts
it("requires a supported skills target", async () => {
  const projectRoot = await makeRoot();
  await expect(runCli(["skills", "install", "--target", "cursor"], projectRoot)).rejects.toThrow("--target must be codex or claude");
});
```

- [ ] **Step 5: Run skills and CLI tests and verify they pass**

Run:

```bash
npm test -- test/skills-install.test.ts test/cli.test.ts test/project.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit packaged skills installation**

```bash
git add src/skills-install.ts src/cli.ts test/skills-install.test.ts test/cli.test.ts
git commit -m "feat: install packaged DocNexus skills"
```

### Task 5: Publishable Package Boundary

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Add a failing package-manifest verification test**

Create `test/package.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("npm package contract", () => {
  it("publishes the scoped package through the docnexus executable with packaged skills", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));

    expect(packageJson.name).toBe("@docnexus/docnexus");
    expect(packageJson.private).toBe(false);
    expect(packageJson.bin).toEqual({ docnexus: "./dist/src/cli.js" });
    expect(packageJson.files).toEqual(expect.arrayContaining(["dist/src", "skills", "README.md", "README.zh-CN.md"]));
    expect(packageJson.scripts.prepack).toBe("npm run build");
  });
});
```

- [ ] **Step 2: Run the manifest test and verify the current local package fails it**

Run:

```bash
npm test -- test/package.test.ts
```

Expected: FAIL because the package is named `docnexus`, is private, and still exposes `docnexus-mcp`.

- [ ] **Step 3: Change the package metadata to the approved public boundary**

Edit `package.json`:

```json
{
  "name": "@docnexus/docnexus",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "files": ["dist/src", "skills", "README.md", "README.zh-CN.md"],
  "bin": {
    "docnexus": "./dist/src/cli.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "prepack": "npm run build",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "mcp": "node dist/src/cli.js mcp"
  }
}
```

Preserve all current dependencies and dev dependencies. Keep `src/index.ts` only as a developer compatibility entrypoint; do not publish a second `docnexus-mcp` binary.

Refresh only package metadata in the lockfile:

```bash
npm install --package-lock-only
```

- [ ] **Step 4: Verify the package manifest and tarball contents**

Run:

```bash
npm test -- test/package.test.ts
npm run build
npm pack --dry-run
```

Expected: tests and build PASS; dry-run output includes `dist/src/cli.js`, `dist/src/mcp.js`, `skills/docnexus-capture/SKILL.md`, `skills/docnexus-recall/SKILL.md`, `README.md`, and `README.zh-CN.md`, and does not expose a `docnexus-mcp` binary.

- [ ] **Step 5: Commit the distribution metadata**

```bash
git add package.json package-lock.json test/package.test.ts
git commit -m "build: prepare scoped DocNexus package"
```

### Task 6: Portable Setup and Workflow Documentation

**Files:**
- Modify: `skills/docnexus-capture/SKILL.md`
- Modify: `skills/docnexus-recall/SKILL.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/product-brief-docnexus-mvp.md`
- Modify: `docs/product-brief-docnexus-mvp.en.md`
- Modify: `docs/product-brief-docnexus-mvp.zh-CN.md`

- [ ] **Step 0: Load the skill-editing workflow before modifying packaged skills**

Invoke `superpowers:writing-skills` before editing `skills/docnexus-capture/SKILL.md` or `skills/docnexus-recall/SKILL.md`, because these files are distributed agent instructions rather than ordinary prose documentation.

- [ ] **Step 1: Replace installed-skill command assumptions**

In `skills/docnexus-recall/SKILL.md`, remove the source-checkout fallback:

````markdown
3. Run recall from an initialized DocNexus project:

```bash
docnexus recall "<query>" --limit 5
```

If the command reports that the project is not initialized, tell the user to run `docnexus init` in the project before retrying. Do not fall back to a repository-local `dist/src/cli.js` path.
````

In `skills/docnexus-capture/SKILL.md`, add the same project-domain prerequisite near the MCP workflow:

```markdown
The MCP server must be configured for the initialized target project. If MCP reports that the project is not initialized, instruct the user to run `docnexus init` in that project before archiving.
```

- [ ] **Step 2: Rewrite the English README setup around installed executable and explicit project setup**

Replace the end-user requirements/install/MCP setup portion of `README.md` with:

````markdown
## Installation And Project Setup

Requirements:

- Node.js with `node:sqlite` support.
- npm.
- A local agent that supports MCP tools, such as Codex or Claude.

Install the executable once:

```bash
npm install -g @docnexus/docnexus
```

Initialize each project that should have its own DocNexus memory:

```bash
cd /path/to/your-project
docnexus init
docnexus skills install --target codex
docnexus skills install --target claude
```

`docnexus init` creates the project-local `.docnexus/` data domain. The installed package is reusable; indexes, archived documents, embeddings, and graph data are not shared between projects.

Without a global installation, use the scoped package name on first invocation:

```bash
npx -y @docnexus/docnexus init
npx -y @docnexus/docnexus skills install --target codex
```

Install skills for all projects only when that broader scope is intended:

```bash
docnexus skills install --target codex --scope user
docnexus skills install --target claude --scope user
```

## MCP Usage

Register one MCP entry for each initialized project that an agent should access. MCP is started by the client as an on-demand stdio process bound to that one project; it is not a shared long-running daemon.

Codex:

```bash
codex mcp add docnexus-my-project -- docnexus mcp --project-root /path/to/your-project
```

```toml
[mcp_servers.docnexus-my-project]
command = "docnexus"
args = ["mcp", "--project-root", "/path/to/your-project"]
```

Claude Code:

```bash
claude mcp add --transport stdio docnexus-my-project -- docnexus mcp --project-root /path/to/your-project
```

```json
{
  "mcpServers": {
    "docnexus-my-project": {
      "command": "docnexus",
      "args": ["mcp", "--project-root", "/path/to/your-project"]
    }
  }
}
```
````

In the development section of `README.md`, replace repository-build MCP startup with:

````markdown
For source development before package publication:

```bash
npm install
npm run build
node dist/src/cli.js --project-root /path/to/your-project init
node dist/src/cli.js mcp --project-root /path/to/your-project
```

The source checkout and the managed project are separate directories.
````

Update the storage tree to include:

```text
.docnexus/
  project.json
```

- [ ] **Step 3: Apply the corresponding Chinese README setup**

Replace the end-user requirements/install/MCP setup portion of `README.zh-CN.md` with:

````markdown
## 安装与项目初始化

环境要求：

- 支持 `node:sqlite` 的 Node.js。
- npm。
- 可使用 MCP tools 的本地智能体，例如 Codex 或 Claude。

只安装一次可执行程序：

```bash
npm install -g @docnexus/docnexus
```

对每个需要独立记忆空间的项目执行初始化：

```bash
cd /path/to/your-project
docnexus init
docnexus skills install --target codex
docnexus skills install --target claude
```

`docnexus init` 会在项目中创建独立的 `.docnexus/` 数据域。安装的程序可以复用，但不同项目之间不共享索引、归档文档、embedding 或图谱数据。

不进行全局安装时，首次执行使用完整作用域包名：

```bash
npx -y @docnexus/docnexus init
npx -y @docnexus/docnexus skills install --target codex
```

仅在明确需要对所有项目提供技能时使用用户级安装：

```bash
docnexus skills install --target codex --scope user
docnexus skills install --target claude --scope user
```

## MCP 使用方式

对每个需要被智能体访问的已初始化项目，手动注册一个 MCP 配置。MCP 是客户端按需启动、固定绑定一个项目的 stdio 进程，不是共享的长期后台服务。

Codex：

```bash
codex mcp add docnexus-my-project -- docnexus mcp --project-root /path/to/your-project
```

```toml
[mcp_servers.docnexus-my-project]
command = "docnexus"
args = ["mcp", "--project-root", "/path/to/your-project"]
```

Claude Code：

```bash
claude mcp add --transport stdio docnexus-my-project -- docnexus mcp --project-root /path/to/your-project
```

```json
{
  "mcpServers": {
    "docnexus-my-project": {
      "command": "docnexus",
      "args": ["mcp", "--project-root", "/path/to/your-project"]
    }
  }
}
```
````

In the development section of `README.zh-CN.md`, include:

````markdown
在 npm 包发布前通过源码开发或启动：

```bash
npm install
npm run build
node dist/src/cli.js --project-root /path/to/your-project init
node dist/src/cli.js mcp --project-root /path/to/your-project
```

源码目录和被管理项目目录是两个独立目录。
````

Add `.docnexus/project.json` to the Chinese storage tree as in the English README.

- [ ] **Step 4: Align product briefs with the new deployment boundary**

In the English section of `docs/product-brief-docnexus-mvp.md` and in `docs/product-brief-docnexus-mvp.en.md`, add:

```markdown
- Distribution target: `@docnexus/docnexus`, exposing the `docnexus` executable.
- Project onboarding: users manually run `docnexus init` before storage, indexing, or recall.
- Isolation: each project stores data in its own `.docnexus/` domain; MCP binds exactly one initialized project per stdio process.
- Skills onboarding: users manually install bundled skills for Codex and/or Claude in the desired project.
```

In the Chinese section of `docs/product-brief-docnexus-mvp.md` and in `docs/product-brief-docnexus-mvp.zh-CN.md`, add:

```markdown
- 分发目标：`@docnexus/docnexus`，对用户暴露 `docnexus` 可执行命令。
- 项目接入：用户在进行存储、索引或召回前，手动执行 `docnexus init`。
- 隔离边界：每个项目的数据均保存在自己的 `.docnexus/` 数据域中；每个 MCP stdio 进程只绑定一个已初始化项目。
- Skills 接入：用户在需要使用的项目中，为 Codex 和/或 Claude 手动安装随包提供的 skills。
```

Preserve existing grouped recall, real embedding, and Graph RAG descriptions; this documentation task changes deployment and setup language, not retrieval behavior.

- [ ] **Step 5: Check for obsolete author-specific or source-fallback instructions**

Run:

```bash
rg -n "/Users/rowansen/Documents/project/docNeuxs|node dist/src/index\\.js|node dist/src/cli\\.js recall" README.md README.zh-CN.md docs/product-brief-docnexus-mvp*.md skills
```

Expected: no matches.

- [ ] **Step 6: Commit the portable user documentation**

```bash
git add README.md README.zh-CN.md docs/product-brief-docnexus-mvp.md docs/product-brief-docnexus-mvp.en.md docs/product-brief-docnexus-mvp.zh-CN.md skills/docnexus-capture/SKILL.md skills/docnexus-recall/SKILL.md
git commit -m "docs: describe portable DocNexus setup"
```

### Task 7: Full Regression and Isolation Verification

**Files:**
- Modify if required by newly revealed public-boundary failures: `test/cli.test.ts`
- Modify if required by newly revealed public-boundary failures: `test/mcp.test.ts`

- [ ] **Step 1: Add one end-to-end CLI isolation assertion if not already covered by prior CLI tests**

Add to `test/cli.test.ts`:

```ts
it("keeps recall evidence isolated between initialized project roots", async () => {
  const projectA = await makeRoot();
  const projectB = await makeRoot();
  await runCli(["init"], projectA);
  await runCli(["init"], projectB);

  const pathA = join(projectA, "a.md");
  const pathB = join(projectB, "b.md");
  await writeFile(pathA, "Alpha isolated recall evidence.");
  await writeFile(pathB, "Beta separate memory.");

  const recordA = await archiveRecord(projectA, {
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
  const recordB = await archiveRecord(projectB, {
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

  await runCli(["index", "upsert", pathA, "--record-id", recordA.id], projectA);
  await runCli(["index", "upsert", pathB, "--record-id", recordB.id], projectB);

  const outputA = JSON.parse(await runCli(["recall", "Alpha isolated recall evidence", "--limit", "5"], projectA));
  expect(outputA.context_groups.map((group: { document: { path: string } }) => group.document.path)).toContain("a.md");
  expect(outputA.context_groups.map((group: { document: { path: string } }) => group.document.path)).not.toContain("b.md");
});
```

- [ ] **Step 2: Run focused isolation verification**

Run:

```bash
npm test -- test/project.test.ts test/skills-install.test.ts test/cli.test.ts test/mcp.test.ts test/package.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the standard test, typecheck, and build suite**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: PASS with no type errors, test failures, build failures, or whitespace errors.

- [ ] **Step 4: Run the real LadybugDB regression path**

Run:

```bash
DOCNEXUS_LADYBUG_INTEGRATION=1 npm test -- test/ladybug-store.test.ts test/cli.test.ts
```

Expected: PASS; explicitly initialized CLI projects retain real embedding/graph recall behavior and no grouped recall contract changes are introduced.

- [ ] **Step 5: Inspect the packaged artifact after build**

Run:

```bash
npm pack --dry-run
git status --short
```

Expected: package dry-run contains runtime entrypoints, both skill definitions, and both READMEs; working tree contains only intended committed changes or is clean.

- [ ] **Step 6: Commit the isolation regression, if Step 1 added a new test after earlier commits**

```bash
git add test/cli.test.ts
git commit -m "test: verify project recall isolation"
```

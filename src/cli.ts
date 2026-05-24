#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { auditGraph, repairGraph } from "./graph-maintenance.js";
import { deleteManagedDocument, getManagedIndexStatus, rebuildManagedDocuments } from "./managed-documents.js";
import { runMcpServer } from "./mcp.js";
import { initializeProject, requireInitializedProject } from "./project.js";
import { recall } from "./recall.js";
import { resetProjectData } from "./reset.js";
import { installSkills } from "./skills-install.js";

export interface RunCliDependencies {
  auditGraph: typeof auditGraph;
  repairGraph: typeof repairGraph;
}

const defaultDependencies: RunCliDependencies = {
  auditGraph,
  repairGraph
};

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

  if (command === "reset") {
    return json(await resetProjectData(projectRoot, { force: invocation.argv.includes("--force") }));
  }

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
    return json(await installSkills({ target, scope, projectRoot }));
  }

  if (command === "index" || command === "graph" || command === "recall" || command === "document") {
    await requireInitializedProject(projectRoot);
  }

  if (command === "document" && subcommand === "delete") {
    const force = rest.includes("--force");
    if (!force) {
      throw new Error("document delete requires --force");
    }
    const options = parseOptions(rest.filter((arg) => arg !== "--force"));
    return json(
      await deleteManagedDocument(projectRoot, {
        file_path: options.file,
        id: options.id,
        confirm: force
      })
    );
  }

  if (command === "index" && subcommand === "rebuild") {
    return json(await rebuildManagedDocuments(projectRoot, { force: rest.includes("--force") }));
  }

  if (command === "index" && subcommand === "status") {
    return json(await getManagedIndexStatus(projectRoot));
  }

  if (command === "graph" && subcommand === "audit") {
    return json(await dependencies.auditGraph(projectRoot));
  }

  if (command === "graph" && subcommand === "repair") {
    return json(await dependencies.repairGraph(projectRoot, { force: rest.includes("--force") }));
  }

  if (command === "recall") {
    const query = subcommand;
    if (!query) {
      throw new Error("query must be a non-empty string");
    }
    const options = parseOptions(rest);
    return json(
      await recall(projectRoot, {
        query,
        limit: options.limit ? Number(options.limit) : undefined
      })
    );
  }

  throw new Error(`Unknown command. Usage:
docnexus init
docnexus --project-root path/to/project init
docnexus skills install --target codex
docnexus skills install --target claude
docnexus skills install --target codex --scope user
docnexus document delete --file path/to/file.md --force
docnexus document delete --id doc_0000000000000000 --force
docnexus reset --force
docnexus index rebuild --force
docnexus graph audit
docnexus graph repair --force
docnexus recall "local memory" --limit 5
docnexus index status`);
}

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

function parseOptions(args: string[]): Record<string, string> {
  const options: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--")) {
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${key} requires a value`);
    }
    options[key.slice(2)] = value;
    index += 1;
  }

  return options;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

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

export function isDirectCliInvocation(
  moduleUrl: string,
  argv1: string | undefined,
  realpath: (path: string) => string = realpathSync.native ?? realpathSync
): boolean {
  if (!argv1) {
    return false;
  }
  try {
    const modulePath = realpath(fileURLToPath(moduleUrl));
    const argvPath = realpath(argv1);
    return modulePath === argvPath;
  } catch {
    return false;
  }
}

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  runMain(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

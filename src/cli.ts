#!/usr/bin/env node
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { runDoctor } from "./doctor.js";
import { installEmbeddingModel } from "./embedding-models.js";
import { auditGraph, repairGraph } from "./graph-maintenance.js";
import {
  deleteManagedDocument,
  getManagedIndexStatus,
  getManagedRecord,
  getManagedStatus,
  listManagedDocuments,
  listManagedRecords,
  rebuildManagedDocuments,
  upsertManagedDocument
} from "./managed-documents.js";
import { validateMetadata } from "./metadata.js";
import { initializeProject, requireInitializedProject } from "./project.js";
import { recall } from "./recall.js";
import { resetProjectData } from "./reset.js";
import { installSkills } from "./skills-install.js";
import type { DocNexusMetadata } from "./types.js";

export interface RunCliDependencies {
  auditGraph?: typeof auditGraph;
  repairGraph?: typeof repairGraph;
  doctor?: typeof runDoctor;
}

const defaultDependencies = {
  auditGraph,
  repairGraph,
  doctor: runDoctor
} satisfies Required<RunCliDependencies>;

export async function runCli(
  argv: string[],
  cwd = process.cwd(),
  dependencies: RunCliDependencies = defaultDependencies
): Promise<string> {
  const activeDependencies: Required<RunCliDependencies> = { ...defaultDependencies, ...dependencies };
  const invocation = parseInvocation(argv, cwd);
  const [command, subcommand, ...rest] = invocation.argv;
  const projectRoot = invocation.projectRoot;

  if (command === "init") {
    return json(await initializeProject(projectRoot));
  }

  if (command === "reset") {
    return json(await resetProjectData(projectRoot, { force: invocation.argv.includes("--force") }));
  }

  if (command === "doctor") {
    return json(await activeDependencies.doctor(projectRoot));
  }

  if (command === "skills" && subcommand === "install") {
    const options = parseOptions(rest);
    const target = options.target;
    if (target !== "codex" && target !== "claude") {
      throw new Error("--target must be codex or claude");
    }
    if (options.scope) {
      throw new Error("skills install supports project scope only; omit --scope");
    }
    return json(await installSkills({ target, projectRoot }));
  }

  if (command === "index" || command === "graph" || command === "recall" || command === "document" || command === "embeddings" || command === "metadata" || command === "status") {
    await requireInitializedProject(projectRoot);
  }

  if (command === "status") {
    return json(await getManagedStatus(projectRoot));
  }

  if (command === "metadata" && subcommand === "validate") {
    const options = parseOptions(rest);
    if (!options.file) {
      throw new Error("metadata validate requires --file");
    }
    return json(validateMetadata(JSON.parse(await readProjectFile(projectRoot, options.file))));
  }

  if (command === "document" && subcommand === "list") {
    const options = parseOptions(rest);
    const limit = options.limit === undefined ? undefined : positiveInteger(options.limit, "limit");
    return json(await listManagedRecords(projectRoot, { limit, tag: options.tag }));
  }

  if (command === "document" && subcommand === "get") {
    const options = parseOptions(rest);
    if (!options.id) {
      throw new Error("document get requires --id");
    }
    const include = options.include?.split(",");
    if (include?.some((item) => !["source", "document", "metadata"].includes(item))) {
      throw new Error("--include must list source,document,metadata");
    }
    return json(await getManagedRecord(projectRoot, options.id, include as ("source" | "document" | "metadata")[] | undefined));
  }

  if (command === "embeddings" && subcommand === "install") {
    const replace = rest.includes("--replace");
    const options = parseOptions(rest.filter((arg) => arg !== "--replace"));
    if (!options.from) {
      throw new Error("embeddings install requires --from");
    }
    return json(await installEmbeddingModel(projectRoot, { sourcePath: await projectContainedPath(projectRoot, options.from), replace }));
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

  if (command === "document" && subcommand === "add") {
    const replace = rest.includes("--replace");
    const options = parseOptions(rest.filter((arg) => arg !== "--replace"));
    if (!options.file || !options["source-file"] || !options["document-file"] || !options["metadata-file"]) {
      throw new Error("document add requires --file, --source-file, --document-file, and --metadata-file");
    }
    const existing = (await listManagedDocuments(projectRoot)).some((document) => document.file_path === options.file);
    if (existing && !replace) {
      throw new Error("document add requires --replace for an existing managed document");
    }
    return json(
      await upsertManagedDocument(projectRoot, {
        file_path: options.file,
        source: await readProjectFile(projectRoot, options["source-file"]),
        document: await readProjectFile(projectRoot, options["document-file"]),
        metadata: JSON.parse(await readProjectFile(projectRoot, options["metadata-file"])) as DocNexusMetadata
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
    return json(await activeDependencies.auditGraph(projectRoot));
  }

  if (command === "graph" && subcommand === "repair") {
    return json(await activeDependencies.repairGraph(projectRoot, { force: rest.includes("--force") }));
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
docnexus doctor
docnexus skills install --target codex
docnexus skills install --target claude
docnexus metadata validate --file .docnexus/drafts/<draft_id>/metadata.json
docnexus document list [--limit 50] [--tag tag]
docnexus document get --id <document_id> [--include source,document,metadata]
docnexus status
docnexus embeddings install --from models/BAAI/bge-small-zh-v1.5
docnexus embeddings install --from models/BAAI/bge-small-zh-v1.5 --replace
docnexus document add --file path/to/file.md --source-file .docnexus/drafts/<draft_id>/source.md --document-file .docnexus/drafts/<draft_id>/document.md --metadata-file .docnexus/drafts/<draft_id>/metadata.json
docnexus document add --file path/to/file.md --source-file .docnexus/drafts/<draft_id>/source.md --document-file .docnexus/drafts/<draft_id>/document.md --metadata-file .docnexus/drafts/<draft_id>/metadata.json --replace
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

function positiveInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

async function readProjectFile(projectRoot: string, path: string): Promise<string> {
  return readFile(await projectContainedPath(projectRoot, path), "utf8");
}

async function projectContainedPath(projectRoot: string, path: string): Promise<string> {
  const root = await realpath(projectRoot);
  const target = await realpath(isAbsolute(path) ? path : resolve(root, path));
  const inside = relative(root, target);
  if (inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) {
    throw new Error(`input path must be inside the project: ${path}`);
  }
  return target;
}

export async function runMain(argv: string[], cwd = process.cwd()): Promise<void> {
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

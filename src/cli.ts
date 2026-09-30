#!/usr/bin/env node
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { runDoctor } from "./doctor.js";
import { createDraft, discardDraft, listDrafts, loadSealedDraft, markDraftIngested, sealDraft, type DraftStatus } from "./drafts.js";
import { installEmbeddingModel } from "./embedding-models.js";
import { auditGraph, repairGraph } from "./graph-maintenance.js";
import {
  deleteManagedDocument,
  getManagedIndexStatus,
  getManagedRecord,
  getManagedStatus,
  isManagedFilePath,
  listManagedRecords,
  rebuildManagedDocuments,
  upsertManagedDocument
} from "./managed-documents.js";
import { libraryRelativePath } from "./layout.js";
import { validateMetadata } from "./metadata.js";
import { initializeProject, requireInitializedProject } from "./project.js";
import { recall } from "./recall.js";
import { resetProjectData } from "./reset.js";
import { linkSkills, parseSkillsTargets, syncSkills } from "./skills.js";

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
    const options = parseOptions(invocation.argv.slice(1));
    const agents = options.agent === undefined || options.agent === "none" ? [] : parseSkillsTargets(options.agent);
    return json(await initializeProject(projectRoot, { agents }));
  }

  if (command === "reset") {
    return json(await resetProjectData(projectRoot, { force: invocation.argv.includes("--force") }));
  }

  if (command === "doctor") {
    return json(await activeDependencies.doctor(projectRoot));
  }

  if (["index", "graph", "recall", "document", "draft", "embeddings", "metadata", "status", "skills"].includes(command)) {
    await requireInitializedProject(projectRoot);
  }

  if (command === "skills" && subcommand === "sync") {
    return json(await syncSkills(projectRoot));
  }

  if (command === "skills" && subcommand === "link") {
    const options = parseOptions(rest);
    const links = [];
    for (const target of parseSkillsTargets(options.target)) {
      links.push(await linkSkills(projectRoot, target));
    }
    return json({ links });
  }

  if (command === "status") {
    const { drafts } = await listDrafts(projectRoot);
    const draftCounts = { open: 0, ready: 0, ingested: 0, invalid: 0 };
    for (const draft of drafts) {
      draftCounts[draft.status] += 1;
    }
    return json({ ...(await getManagedStatus(projectRoot)), drafts: draftCounts });
  }

  if (command === "draft" && subcommand === "new") {
    return json(await createDraft(projectRoot, { slug: parseOptions(rest).slug }));
  }

  if (command === "draft" && subcommand === "seal") {
    const options = parseOptions(rest);
    if (!options.id || !options.file) {
      throw new Error("draft seal requires --id and --file");
    }
    return json(await sealDraft(projectRoot, { draftId: options.id, filePath: options.file }));
  }

  if (command === "draft" && subcommand === "list") {
    const status = parseOptions(rest).status;
    if (status !== undefined && !["open", "ready", "ingested", "invalid"].includes(status)) {
      throw new Error("--status must be open, ready, ingested, or invalid");
    }
    return json(await listDrafts(projectRoot, { status: status as DraftStatus | undefined }));
  }

  if (command === "draft" && subcommand === "discard") {
    const force = rest.includes("--force");
    const options = parseOptions(rest.filter((arg) => arg !== "--force"));
    if (!options.id) {
      throw new Error("draft discard requires --id");
    }
    return json(await discardDraft(projectRoot, { draftId: options.id, force }));
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
    if (!options.draft) {
      throw new Error("document add requires --draft <draft_id>");
    }
    const draft = await loadSealedDraft(projectRoot, options.draft);
    if (!replace && (await isManagedFilePath(projectRoot, draft.manifest.file_path))) {
      throw new Error("document add requires --replace for an existing managed document");
    }
    const result = await upsertManagedDocument(projectRoot, {
      file_path: draft.manifest.file_path,
      source: draft.source,
      document: draft.document,
      metadata: draft.metadata
    });
    await markDraftIngested(projectRoot, draft.manifest.draft_id, result.id);
    return json({ ...result, draft_id: draft.manifest.draft_id, library_path: libraryRelativePath(result.file_path) });
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
${USAGE}`);
}

const USAGE = `Setup
  docnexus init [--agent claude|codex|all]
  docnexus --project-root path/to/project init
  docnexus skills sync
  docnexus skills link --target claude|codex|all
  docnexus doctor
  docnexus status

Capture (extract -> seal -> ingest)
  docnexus draft new [--slug auth]
  docnexus metadata validate --file docnexus/drafts/<draft_id>/metadata.json
  docnexus draft seal --id <draft_id> --file <library_path.md>
  docnexus document add --draft <draft_id> [--replace]
  docnexus draft list [--status open|ready|ingested|invalid]
  docnexus draft discard --id <draft_id> --force

Recall
  docnexus recall "local memory" --limit 5

Library
  docnexus document list [--limit 50] [--tag tag]
  docnexus document get --id <document_id> [--include source,document,metadata]
  docnexus document delete --file <library_path.md> --force
  docnexus document delete --id doc_0000000000000000 --force

Maintenance
  docnexus index status
  docnexus index rebuild --force
  docnexus graph audit
  docnexus graph repair --force
  docnexus embeddings install --from models/BAAI/bge-small-zh-v1.5 [--replace]
  docnexus reset --force`;

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

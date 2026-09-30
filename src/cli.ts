#!/usr/bin/env node
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { buildConceptIndex, renderConceptIndex, writeConceptIndex } from "./concepts.js";
import { runDoctor } from "./doctor.js";
import { createDraft, discardDraft, listDrafts, loadSealedDraft, markDraftIngested, sealDraft, type DraftStatus } from "./drafts.js";
import { installEmbeddingModel } from "./embedding-models.js";
import { auditGraph, repairGraph } from "./graph-maintenance.js";
import {
  deleteManagedDocument,
  getManagedIndexStatus,
  getManagedRecord,
  ensureManagedStore,
  getManagedStatus,
  inspectIndex,
  isManagedFilePath,
  listManagedRecords,
  rebuildManagedDocuments,
  reconcileIndex,
  syncManagedDocument,
  upsertManagedDocument
} from "./managed-documents.js";
import { libraryRelativePath } from "./layout.js";
import { validateMetadata } from "./metadata.js";
import { initializeProject, requireInitializedProject } from "./project.js";
import { recall } from "./recall.js";
import { resetProjectData } from "./reset.js";
import { ensureSkillsCurrent, inspectSkills, linkSkills, parseSkillsTargets, syncSkills } from "./skills.js";
import { entityTypes, type DocNexusMetadata } from "./types.js";

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

  if (["index", "graph", "recall", "document", "draft", "embeddings", "metadata", "status", "skills", "concepts"].includes(command)) {
    await requireInitializedProject(projectRoot);
    // The store is derived and may be absent after a clone; the workspace skills follow the installed package.
    await ensureManagedStore(projectRoot);
    if (!(command === "skills" && subcommand === "sync")) {
      const synced = await ensureSkillsCurrent(projectRoot);
      if (synced) {
        process.stderr.write(`docnexus: refreshed docnexus/skills to ${synced.version}\n`);
      }
    }
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
    const index = await inspectIndex(projectRoot);
    const skills = await inspectSkills(projectRoot);
    return json({
      ...(await getManagedStatus(projectRoot)),
      drafts: draftCounts,
      index: {
        in_sync: index.in_sync,
        unindexed: index.unindexed.length,
        outdated: index.outdated.length,
        orphaned: index.orphaned.length,
        edited_library_files: index.edited,
        missing_library_files: index.missing_library
      },
      skills: { version: skills.version, outdated: skills.outdated, missing: skills.missing }
    });
  }

  if (command === "concepts") {
    const options = parseOptions(invocation.argv.slice(1));
    if (options.type !== undefined && !(entityTypes as readonly string[]).includes(options.type)) {
      throw new Error(`--type must be one of ${entityTypes.join(", ")}`);
    }
    if (options.format !== undefined && options.format !== "json" && options.format !== "md") {
      throw new Error("--format must be json or md");
    }
    const index = await buildConceptIndex(projectRoot, { type: options.type, query: options.query });
    return options.format === "md" ? renderConceptIndex(index) : json(index);
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
    const deleted = await deleteManagedDocument(projectRoot, {
      file_path: options.file,
      id: options.id,
      confirm: force
    });
    await writeConceptIndex(projectRoot);
    return json(deleted);
  }

  if (command === "document" && subcommand === "sync") {
    const options = parseOptions(rest);
    const metadata = options["metadata-file"]
      ? (JSON.parse(await readProjectFile(projectRoot, options["metadata-file"])) as DocNexusMetadata)
      : undefined;
    const result = await syncManagedDocument(projectRoot, { id: options.id, file_path: options.file, metadata });
    await writeConceptIndex(projectRoot);
    return json({ ...result, library_path: libraryRelativePath(result.file_path) });
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
    await writeConceptIndex(projectRoot);
    return json({ ...result, draft_id: draft.manifest.draft_id, library_path: libraryRelativePath(result.file_path) });
  }

  if (command === "index" && subcommand === "rebuild") {
    const rebuilt = await rebuildManagedDocuments(projectRoot, { force: rest.includes("--force") });
    await writeConceptIndex(projectRoot);
    return json(rebuilt);
  }

  if (command === "index" && subcommand === "sync") {
    const synced = await reconcileIndex(projectRoot, { all: false });
    await writeConceptIndex(projectRoot);
    return json(synced);
  }

  if (command === "index" && subcommand === "status") {
    return json({ ...(await getManagedIndexStatus(projectRoot)), ...(await inspectIndex(projectRoot)) });
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
    // Recall must reflect the committed text records, e.g. after a git pull.
    if (!(await inspectIndex(projectRoot)).in_sync) {
      const synced = await reconcileIndex(projectRoot, { all: false });
      await writeConceptIndex(projectRoot);
      process.stderr.write(`docnexus: synced index before recall (${synced.rebuilt_documents} indexed, ${synced.removed_documents} removed)\n`);
    }
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
  docnexus concepts [--type component] [--query auth] [--format json|md]

Library
  docnexus document list [--limit 50] [--tag tag]
  docnexus document get --id <document_id> [--include source,document,metadata]
  docnexus document sync --id <document_id> [--metadata-file <path>]
  docnexus document sync --file <library_path.md> [--metadata-file <path>]
  docnexus document delete --file <library_path.md> --force
  docnexus document delete --id doc_0000000000000000 --force

Maintenance
  docnexus index status
  docnexus index sync
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

#!/usr/bin/env node
import { DocNexusError, asDocNexusError, errorEnvelope, errorDefinitions, PROTOCOL_VERSION } from "./errors.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { buildConceptIndex, renderConceptIndex, writeConceptIndex } from "./concepts.js";
import { runDoctor } from "./doctor.js";
import { createDraft, discardDraft, listDrafts, sealDraft, type DraftStatus } from "./drafts.js";
import {
  deleteManagedDocument,
  classifyManagedDocument,
  ensureManagedWorkspace,
  getManagedRecord,
  inspectRecords,
  getManagedStatus,
  listManagedRecords,
  refreshFactViews,
  syncManagedDocument
} from "./managed-documents.js";
import { ingestDraft } from "./document-service.js";
import { libraryRelativePath } from "./layout.js";
import { validateMetadata } from "./metadata.js";
import { initializeProject, requireInitializedProject } from "./project.js";
import { recallEvidence } from "./recall-evidence.js";
import type { EvidenceUnit } from "./evidence.js";
import { recall } from "./recall.js";
import { inspectRetrievalIndex, syncRetrievalIndex } from "./retrieval-index.js";
import { auditGraph, repairGraph } from "./graph-maintenance.js";
import { installEmbeddingModel } from "./embedding-models.js";
import { searchDocuments } from "./search.js";
import { resetProjectData } from "./reset.js";
import { ensureSkillsCurrent, inspectSkills, linkSkills, parseSkillsTargets, syncSkills } from "./skills.js";
import { entityTypes, type DocNexusMetadata, type DocumentCategory } from "./types.js";
import { listFacts } from "./knowledge-service.js";
import { withProjectLock } from "./project-lock.js";
import { queryDocuments } from "./document-query.js";
import { startDocumentViewer } from "./viewer.js";

export interface RunCliDependencies {
  doctor?: typeof runDoctor;
}

const defaultDependencies = {
  doctor: runDoctor
} satisfies Required<RunCliDependencies>;

export async function runCli(
  argv: string[],
  cwd = process.cwd(),
  dependencies: RunCliDependencies = defaultDependencies
): Promise<string> {
  try {
    const invocation = parseInvocation(argv, cwd);
    const [command, subcommand] = invocation.argv;
    const computesEmbeddings = command === "recall" || (command === "index" && ["sync", "rebuild"].includes(subcommand)) || (command === "graph" && subcommand === "repair");
    return await (computesEmbeddings ? runCliUnlocked(argv, cwd, dependencies)
      : withProjectLock(invocation.projectRoot, () => runCliUnlocked(argv, cwd, dependencies)));
  } catch (error) { throw asDocNexusError(error); }
}

async function runCliUnlocked(argv: string[], cwd: string, dependencies: RunCliDependencies): Promise<string> {
  const activeDependencies: Required<RunCliDependencies> = { ...defaultDependencies, ...dependencies };
  const invocation = parseInvocation(argv, cwd);
  const [command, subcommand, ...rest] = invocation.argv;
  const projectRoot = invocation.projectRoot;

  if (command === "protocol") return json({ protocol_version: PROTOCOL_VERSION, errors: errorDefinitions });

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

  if (["facts", "index", "graph", "embeddings", "search", "recall", "document", "draft", "metadata", "status", "skills", "concepts"].includes(command)) {
    await withProjectLock(projectRoot, async () => {
      await requireInitializedProject(projectRoot);
      // Workspace skills follow the installed package; reads use text records directly.
      if (!(command === "skills" && subcommand === "sync")) {
        const synced = await ensureSkillsCurrent(projectRoot);
        if (synced) {
          await ensureManagedWorkspace(projectRoot);
          process.stderr.write(`docnexus: refreshed docnexus/skills to ${synced.version}\n`);
        }
      }
    });
  }

  if (command === "skills" && subcommand === "sync") {
    await ensureManagedWorkspace(projectRoot);
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
    const records = await inspectRecords(projectRoot);
    const skills = await inspectSkills(projectRoot);
    return json({
      ...(await getManagedStatus(projectRoot)),
      drafts: draftCounts,
      records,
      index: await inspectRetrievalIndex(projectRoot),
      skills: { version: skills.version, outdated: skills.outdated, missing: skills.missing }
    });
  }

  if (command === "concepts") {
    const options = parseOptions(invocation.argv.slice(1));
    if (options.type !== undefined && !(entityTypes as readonly string[]).includes(options.type)) {
      throw new DocNexusError("invalid_params", `--type must be one of ${entityTypes.join(", ")}`);
    }
    if (options.format !== undefined && options.format !== "json" && options.format !== "md") {
      throw new DocNexusError("invalid_params", "--format must be json or md");
    }
    const index = await buildConceptIndex(projectRoot, { type: options.type, query: options.query });
    return options.format === "md" ? renderConceptIndex(index) : json(index);
  }

  if (command === "facts" && subcommand === "list") {
    const includeInactive = rest.includes("--include-inactive");
    const options = parseOptions(rest.filter((arg) => arg !== "--include-inactive"));
    return json(await listFacts(projectRoot, { entity: options.entity, at: options.at, includeInactive }));
  }

  if (command === "draft" && subcommand === "new") {
    return json(await createDraft(projectRoot, { slug: parseOptions(rest).slug }));
  }

  if (command === "draft" && subcommand === "seal") {
    const options = parseOptions(rest);
    if (!options.id || !options.file) {
      throw new DocNexusError("invalid_params", "draft seal requires --id and --file");
    }
    return json(await sealDraft(projectRoot, { draftId: options.id, filePath: options.file,
      baseRecordHash: options["base-version"] === "new" ? null : options["base-version"],
      category: options.category, categoryReason: options["category-reason"] }));
  }

  if (command === "draft" && subcommand === "list") {
    const status = parseOptions(rest).status;
    if (status !== undefined && !["open", "ready", "ingested", "invalid"].includes(status)) {
      throw new DocNexusError("invalid_params", "--status must be open, ready, ingested, or invalid");
    }
    return json(await listDrafts(projectRoot, { status: status as DraftStatus | undefined }));
  }

  if (command === "draft" && subcommand === "discard") {
    const force = rest.includes("--force");
    const options = parseOptions(rest.filter((arg) => arg !== "--force"));
    if (!options.id) {
      throw new DocNexusError("invalid_params", "draft discard requires --id");
    }
    return json(await discardDraft(projectRoot, { draftId: options.id, force }));
  }

  if (command === "metadata" && subcommand === "validate") {
    const options = parseOptions(rest);
    if (!options.file) {
      throw new DocNexusError("invalid_params", "metadata validate requires --file");
    }
    return json(validateMetadata(JSON.parse(await readProjectFile(projectRoot, options.file))));
  }

  if (command === "document" && subcommand === "list") {
    const options = parseOptions(rest);
    const limit = options.limit === undefined ? undefined : positiveInteger(options.limit, "limit");
    return json(await listManagedRecords(projectRoot, { limit, tag: options.tag }));
  }

  if (command === "document" && subcommand === "query") {
    const all = rest.includes("--all");
    const queryArgs = rest.filter((arg) => arg !== "--all");
    for (let index = 0; index < queryArgs.length; index += 2) {
      if (!queryArgs[index].startsWith("--")) throw new DocNexusError("invalid_params", `unexpected document query argument: ${queryArgs[index]}`);
      if (!["--page", "--page-size", "--category", "--revision"].includes(queryArgs[index])) throw new DocNexusError("invalid_params", `unknown document query option: ${queryArgs[index]}`);
    }
    const options = parseOptions(queryArgs);
    return json(await queryDocuments(projectRoot, {
      all,
      page: options.page === undefined ? undefined : positiveInteger(options.page, "page"),
      page_size: options["page-size"] === undefined ? undefined : positiveInteger(options["page-size"], "page-size"),
      category: options.category as DocumentCategory | undefined,
      revision: options.revision
    }));
  }

  if (command === "document" && subcommand === "get") {
    const options = parseOptions(rest);
    if (!options.id) {
      throw new DocNexusError("invalid_params", "document get requires --id");
    }
    const include = options.include?.split(",");
    if (include?.some((item) => !["source", "document", "metadata", "timeline", "template"].includes(item))) {
      throw new DocNexusError("invalid_params", "--include must list source,document,metadata,timeline,template");
    }
    return json(await getManagedRecord(projectRoot, options.id, include as ("source" | "document" | "metadata" | "timeline" | "template")[] | undefined));
  }

  if (command === "document" && subcommand === "render") {
    return json(await refreshFactViews(projectRoot));
  }

  if (command === "document" && subcommand === "classify") {
    for (let index = 0; index < rest.length; index += 2) {
      if (!["--id", "--category", "--reason", "--revision"].includes(rest[index])) throw new DocNexusError("invalid_params", `unknown document classify option: ${rest[index]}`);
    }
    const options = parseOptions(rest);
    if (!options.id || !options.category || !options.reason) throw new DocNexusError("invalid_params", "document classify requires --id, --category and --reason");
    return json(await classifyManagedDocument(projectRoot, { id: options.id, category: options.category, reason: options.reason, revision: options.revision }));
  }

  if (command === "document" && subcommand === "delete") {
    const force = rest.includes("--force");
    if (!force) {
      throw new DocNexusError("confirmation_required", "document delete requires --force");
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
    if (options.category !== undefined || options["category-reason"] !== undefined) {
      throw new DocNexusError("invalid_params", "set classification with draft seal --category before reviewing the draft; document add uses its sealed metadata");
    }
    if (!options.draft) {
      throw new DocNexusError("invalid_params", "document add requires --draft <draft_id>");
    }
    const result = await ingestDraft(projectRoot, { draftId: options.draft, replace });
    await writeConceptIndex(projectRoot);
    return json({ ...result, draft_id: options.draft, library_path: libraryRelativePath(result.file_path) });
  }

  if (command === "index" && (subcommand === "sync" || subcommand === "rebuild")) {
    if (subcommand === "rebuild" && !rest.includes("--force")) {
      throw new DocNexusError("confirmation_required", "index rebuild requires --force");
    }
    const result = await syncRetrievalIndex(projectRoot, { all: subcommand === "rebuild" });
    await writeConceptIndex(projectRoot);
    return json(result);
  }

  if (command === "index" && subcommand === "status") {
    return json({ ...(await inspectRetrievalIndex(projectRoot)), records: await inspectRecords(projectRoot) });
  }

  if (command === "graph" && subcommand === "audit") {
    return json(await auditGraph(projectRoot));
  }

  if (command === "graph" && subcommand === "repair") {
    return json(await repairGraph(projectRoot, { force: rest.includes("--force") }));
  }

  if (command === "embeddings" && subcommand === "install") {
    const replace = rest.includes("--replace");
    const options = parseOptions(rest.filter((arg) => arg !== "--replace"));
    if (!options.from) throw new DocNexusError("invalid_params", "embeddings install requires --from");
    return json(await installEmbeddingModel(projectRoot, { sourcePath: await projectContainedPath(projectRoot, options.from), replace }));
  }

  if (command === "search" || command === "recall") {
    if (!subcommand) {
      throw new DocNexusError("invalid_params", "query must be a non-empty string");
    }
    const options = parseOptions(rest);
    const input = { query: subcommand, category: options.category, limit: options.limit === undefined ? undefined : positiveInteger(options.limit, "limit") };
    if (options.mode !== undefined && (command !== "recall" || !["hybrid", "vector"].includes(options.mode))) throw new DocNexusError("invalid_params", "recall --mode must be hybrid or vector");
    const mode = options.mode as "hybrid" | "vector" | undefined;
    if (options["context-budget"] !== undefined || options["return-unit"] !== undefined) {
      if (command !== "recall") throw new DocNexusError("invalid_params", "evidence delivery options require recall");
      return json(await recallEvidence(projectRoot, { ...input, mode,
        context_budget: options["context-budget"] === undefined ? undefined : positiveInteger(options["context-budget"], "context-budget"),
        return_unit: options["return-unit"] as EvidenceUnit | undefined }));
    }
    return json(command === "search" ? await searchDocuments(projectRoot, input) : await recall(projectRoot, { ...input, mode }));
  }

  throw new DocNexusError("unknown_command", `Unknown command. Usage:
${USAGE}`);
}

const USAGE = `Setup
  docnexus init [--agent claude|codex|all]
  docnexus --project-root path/to/project init
  docnexus skills sync
  docnexus skills link --target claude|codex|all
  docnexus doctor [--json]
  docnexus protocol
  docnexus status

Capture (extract -> seal -> ingest)
  docnexus draft new [--slug auth]
  docnexus metadata validate --file docnexus/drafts/<draft_id>/metadata.json
  docnexus draft seal --id <draft_id> --file <library_path.md> [--base-version <record_version|new>] [--category <name> [--category-reason <basis>]]
  docnexus document add --draft <draft_id> [--replace]
  docnexus draft list [--status open|ready|ingested|invalid]
  docnexus draft discard --id <draft_id> --force

Find and read
  docnexus search "local memory" --limit 5 [--category <name>]
  docnexus recall "local memory" --limit 5 [--mode hybrid|vector] [--category <name>]
  docnexus recall "local memory" --return-unit window|section|page --context-budget 4000 [--category <name>]
  docnexus concepts [--type component] [--query auth] [--format json|md]
  docnexus facts list [--entity name-or-alias] [--at ISO-timestamp] [--include-inactive]

Library
  docnexus document query [--all | --page 1 --page-size 20] [--category guide] [--revision <snapshot>]
  docnexus view [--port 0]   # Local read-only document browser; Ctrl+C to stop
  docnexus document list [--limit 50] [--tag tag]
  docnexus document get --id <document_id> [--include source,document,metadata,timeline,template]
  docnexus document render
  docnexus document classify --id <document_id> --category <project-category> --reason <basis> [--revision <snapshot>]
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
  docnexus embeddings install --from <model_dir> [--replace]
  docnexus reset --force`;

function parseInvocation(argv: string[], cwd: string): { argv: string[]; projectRoot: string; json: boolean } {
  const args = [...argv];
  let projectRoot = resolve(cwd), json = false;
  while (args[0] === "--json" || args[0] === "--project-root") {
    if (args.shift() === "--json") { json = true; continue; }
    const root = args.shift();
    if (!root || root.startsWith("--")) throw new DocNexusError("invalid_params", "--project-root requires a value");
    projectRoot = resolve(cwd, root);
  }
  const filtered = args.filter((arg, index) => {
    if (arg !== "--json" || (index === 1 && ["search", "recall"].includes(args[0]))) return true;
    json = true; return false;
  });
  return { argv: filtered, projectRoot, json };
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
      throw new DocNexusError("invalid_params", `${key} requires a value`);
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
    throw new DocNexusError("invalid_params", `${name} must be a positive integer`);
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
    throw new DocNexusError("invalid_params", `input path must be inside the project: ${path}`);
  }
  return target;
}

export async function runMain(argv: string[], cwd = process.cwd()): Promise<void> {
  try {
    const invocation = parseInvocation(argv, cwd);
    if (invocation.argv[0] === "view") {
      const args = invocation.argv.slice(1);
      if (args.length !== 0 && (args.length !== 2 || args[0] !== "--port" || !/^\d+$/.test(args[1]))) {
        throw new DocNexusError("invalid_params", "Usage: docnexus view [--port 0]");
      }
      const viewer = await startDocumentViewer(invocation.projectRoot, args.length ? Number(args[1]) : 0);
      process.stdout.write(`DocNexus document viewer: ${viewer.url}\nProject: ${invocation.projectRoot}\nRead-only · Ctrl+C to stop\n`);
      const stop = () => { void viewer.close().catch(() => { process.exitCode = 1; }); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      return;
    }
    process.stdout.write(await runCli(argv, cwd));
  } catch (error) {
    let root = resolve(cwd), machine = argv.includes("--json");
    try { const invocation = parseInvocation(argv, cwd); root = invocation.projectRoot; machine = invocation.json; } catch {}
    if (!machine) throw asDocNexusError(error);
    const envelope = errorEnvelope(error, root);
    process.stdout.write(json(envelope));
    process.exitCode = 1;
  }
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
  void runMain(process.argv.slice(2)).catch(error => {
    let root = process.cwd();
    try { root = parseInvocation(process.argv.slice(2), root).projectRoot; } catch {}
    const envelope = errorEnvelope(error, root);
    process.stderr.write(`${envelope.code}: ${envelope.message}\nNext: ${envelope.next_action.message}\n`);
    process.exitCode = 1;
  });
}

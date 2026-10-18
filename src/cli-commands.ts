import { DocNexusError, errorDefinitions, PROTOCOL_VERSION } from "./errors.js";
import { buildConceptIndex, renderConceptListing, writeConceptIndex } from "./concepts.js";
import type { runDoctor } from "./doctor.js";
import { createDraft, discardDraft, listDrafts, previewDraft, sealDraft, type DraftStatus } from "./drafts.js";
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
import { inspectSkills, linkSkills, parseSkillsTargets, syncSkills } from "./skills.js";
import { entityTypes, isDocumentCategory, type DocNexusMetadata, type DocumentCategory } from "./types.js";
import { listFacts } from "./knowledge-service.js";
import { queryDocuments } from "./document-query.js";
import { configureUsage, exportUsage, recordUsageFeedback, usageStatus } from "./usage.js";
import { getImpact, listImpacts, saveImpact, setImpactStatus } from "./impacts.js";
import {
  json,
  optionalPositiveInteger,
  parseOptions,
  projectContainedPath,
  readProjectFile,
  requireKnownOptions,
  takeFlag
} from "./cli-options.js";

export interface CommandContext {
  projectRoot: string;
  subcommand: string | undefined;
  /** Arguments after the subcommand. */
  rest: string[];
  /** Arguments after the command, for commands whose options start right after it. */
  args: string[];
  doctor: typeof runDoctor;
}

export type CommandHandler = (context: CommandContext) => Promise<string>;

/**
 * A command either handles every invocation itself or dispatches on its subcommand.
 * `workspace` commands run after the initialized-project and skills-refresh preflight.
 */
export interface CommandDefinition {
  workspace: boolean;
  run?: CommandHandler;
  subcommands?: Record<string, CommandHandler>;
}

const DOCUMENT_INCLUDES = ["source", "document", "metadata", "timeline", "template"] as const;
type DocumentInclude = (typeof DOCUMENT_INCLUDES)[number];

// Setup and maintenance outside the workspace preflight.

const protocol: CommandHandler = async () => json({ protocol_version: PROTOCOL_VERSION, errors: errorDefinitions });

const usage: CommandHandler = async ({ projectRoot, subcommand, rest }) => {
  await requireInitializedProject(projectRoot);
  if (subcommand === "feedback") {
    requireKnownOptions(rest, ["--event", "--rating", "--reason"], () => "unknown usage feedback option");
    return json(await recordUsageFeedback(projectRoot, parseOptions(rest)));
  }
  if (rest.length) throw new DocNexusError("invalid_params", "usage commands do not accept extra arguments");
  if (subcommand === "enable" || subcommand === "disable") return json(await configureUsage(projectRoot, subcommand === "enable"));
  if (subcommand === "status") return json(await usageStatus(projectRoot));
  if (subcommand === "export") return json(await exportUsage(projectRoot));
  throw new DocNexusError("invalid_params", "Usage: docnexus usage enable|disable|status|export|feedback");
};

const init: CommandHandler = async ({ projectRoot, args }) => {
  const options = parseOptions(args);
  const agents = options.agent === undefined || options.agent === "none" ? [] : parseSkillsTargets(options.agent);
  return json(await initializeProject(projectRoot, { agents, gitRemote: options["git-remote"] }));
};

const reset: CommandHandler = async ({ projectRoot, args }) =>
  json(await resetProjectData(projectRoot, { force: args.includes("--force") }));

const doctor: CommandHandler = async ({ projectRoot, doctor }) => json(await doctor(projectRoot));

// Workspace setup and status.

const skillsSync: CommandHandler = async ({ projectRoot }) => {
  await ensureManagedWorkspace(projectRoot);
  return json(await syncSkills(projectRoot));
};

const skillsLink: CommandHandler = async ({ projectRoot, rest }) => {
  const options = parseOptions(rest);
  const links = [];
  for (const target of parseSkillsTargets(options.target)) {
    links.push(await linkSkills(projectRoot, target));
  }
  return json({ links });
};

const status: CommandHandler = async ({ projectRoot }) => {
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
};

// Capture: extract -> seal -> ingest.

const draftNew: CommandHandler = async ({ projectRoot, rest }) =>
  json(await createDraft(projectRoot, { slug: parseOptions(rest).slug }));

const draftSeal: CommandHandler = async ({ projectRoot, rest }) => {
  const options = parseOptions(rest);
  if (!options.id || !options.file) {
    throw new DocNexusError("invalid_params", "draft seal requires --id and --file");
  }
  return json(await sealDraft(projectRoot, {
    draftId: options.id,
    filePath: options.file,
    baseRecordHash: options["base-version"] === "new" ? null : options["base-version"],
    category: options.category,
    categoryReason: options["category-reason"]
  }));
};

const draftPreview: CommandHandler = async ({ projectRoot, rest }) => {
  const options = parseOptions(rest);
  if (!options.id) throw new DocNexusError("invalid_params", "draft preview requires --id");
  return json(await previewDraft(projectRoot, options.id));
};

const draftList: CommandHandler = async ({ projectRoot, rest }) => {
  const status = parseOptions(rest).status;
  if (status !== undefined && !["open", "ready", "ingested", "invalid"].includes(status)) {
    throw new DocNexusError("invalid_params", "--status must be open, ready, ingested, or invalid");
  }
  return json(await listDrafts(projectRoot, { status: status as DraftStatus | undefined }));
};

const draftDiscard: CommandHandler = async ({ projectRoot, rest }) => {
  const [force, args] = takeFlag(rest, "--force");
  const options = parseOptions(args);
  if (!options.id) {
    throw new DocNexusError("invalid_params", "draft discard requires --id");
  }
  return json(await discardDraft(projectRoot, { draftId: options.id, force }));
};

const metadataValidate: CommandHandler = async ({ projectRoot, rest }) => {
  const options = parseOptions(rest);
  if (!options.file) {
    throw new DocNexusError("invalid_params", "metadata validate requires --file");
  }
  return json(validateMetadata(JSON.parse(await readProjectFile(projectRoot, options.file))));
};

const documentAdd: CommandHandler = async ({ projectRoot, rest }) => {
  const [replace, args] = takeFlag(rest, "--replace");
  const options = parseOptions(args);
  if (options.category !== undefined || options["category-reason"] !== undefined) {
    throw new DocNexusError("invalid_params",
      "set classification with draft seal --category before reviewing the draft; document add uses its sealed metadata");
  }
  if (!options.draft) {
    throw new DocNexusError("invalid_params", "document add requires --draft <draft_id>");
  }
  const result = await ingestDraft(projectRoot, { draftId: options.draft, replace });
  await writeConceptIndex(projectRoot);
  return json({ ...result, draft_id: options.draft, library_path: libraryRelativePath(result.file_path) });
};

// Related-page impact tracking.

const IMPACT_OPTIONS = {
  save: ["--file"],
  list: ["--status"],
  get: ["--id"],
  set: ["--id", "--document", "--status", "--reason", "--revision"]
};

const impact: CommandHandler = async ({ projectRoot, subcommand, rest }) => {
  if (subcommand === undefined || !Object.hasOwn(IMPACT_OPTIONS, subcommand)) {
    throw new DocNexusError("invalid_params", "Usage: docnexus impact save|list|get|set");
  }
  requireKnownOptions(rest, IMPACT_OPTIONS[subcommand as keyof typeof IMPACT_OPTIONS], () => "unknown impact option");
  const options = parseOptions(rest);
  if (subcommand === "list") return json(await listImpacts(projectRoot, options.status));
  if (subcommand === "save" && options.file) {
    return json(await saveImpact(projectRoot, JSON.parse(await readProjectFile(projectRoot, options.file))));
  }
  if (subcommand === "get" && options.id) return json(await getImpact(projectRoot, options.id));
  if (subcommand === "set" && options.id && options.document && options.status && options.reason && options.revision) {
    const { id, document, status, reason, revision } = options;
    return json(await setImpactStatus(projectRoot, { id, document, status, reason, revision }));
  }
  throw new DocNexusError("invalid_params",
    "missing required impact options; use impact save --file, get --id, or set --id --document --status --reason --revision");
};

// Find and read.

const concepts: CommandHandler = async ({ projectRoot, args }) => {
  const options = parseOptions(args);
  if (options.type !== undefined && !(entityTypes as readonly string[]).includes(options.type)) {
    throw new DocNexusError("invalid_params", `--type must be one of ${entityTypes.join(", ")}`);
  }
  if (options.format !== undefined && options.format !== "json" && options.format !== "md") {
    throw new DocNexusError("invalid_params", "--format must be json or md");
  }
  if (options.category !== undefined && !isDocumentCategory(options.category)) {
    throw new DocNexusError("invalid_params", "category must be a trimmed name of 1–80 characters without control characters");
  }
  const index = await buildConceptIndex(projectRoot, { type: options.type, query: options.query, category: options.category });
  return options.format === "md" ? renderConceptListing(index) : json(index);
};

const factsList: CommandHandler = async ({ projectRoot, rest }) => {
  const [includeInactive, args] = takeFlag(rest, "--include-inactive");
  const options = parseOptions(args);
  return json(await listFacts(projectRoot, { entity: options.entity, at: options.at, includeInactive }));
};

/** `search` and `recall` take the query in the subcommand position. */
function findCommand(command: "search" | "recall"): CommandHandler {
  return async ({ projectRoot, subcommand: query, rest }) => {
    if (!query) {
      throw new DocNexusError("invalid_params", "query must be a non-empty string");
    }
    const options = parseOptions(rest);
    const input = { query, category: options.category, limit: optionalPositiveInteger(options.limit, "limit") };
    if (options.mode !== undefined && (command !== "recall" || !["hybrid", "vector"].includes(options.mode))) {
      throw new DocNexusError("invalid_params", "recall --mode must be hybrid or vector");
    }
    const mode = options.mode as "hybrid" | "vector" | undefined;
    if (options["context-budget"] !== undefined || options["return-unit"] !== undefined) {
      if (command !== "recall") throw new DocNexusError("invalid_params", "evidence delivery options require recall");
      return json(await recallEvidence(projectRoot, {
        ...input,
        mode,
        context_budget: optionalPositiveInteger(options["context-budget"], "context-budget"),
        return_unit: options["return-unit"] as EvidenceUnit | undefined
      }));
    }
    return json(command === "search" ? await searchDocuments(projectRoot, input) : await recall(projectRoot, { ...input, mode }));
  };
}

// Library.

const documentList: CommandHandler = async ({ projectRoot, rest }) => {
  const options = parseOptions(rest);
  return json(await listManagedRecords(projectRoot, { limit: optionalPositiveInteger(options.limit, "limit"), tag: options.tag }));
};

const documentQuery: CommandHandler = async ({ projectRoot, rest }) => {
  const [all, args] = takeFlag(rest, "--all");
  requireKnownOptions(args, ["--page", "--page-size", "--category", "--revision"], (option) => option.startsWith("--")
    ? `unknown document query option: ${option}`
    : `unexpected document query argument: ${option}`);
  const options = parseOptions(args);
  return json(await queryDocuments(projectRoot, {
    all,
    page: optionalPositiveInteger(options.page, "page"),
    page_size: optionalPositiveInteger(options["page-size"], "page-size"),
    category: options.category as DocumentCategory | undefined,
    revision: options.revision
  }));
};

const documentGet: CommandHandler = async ({ projectRoot, rest }) => {
  const options = parseOptions(rest);
  if (!options.id) {
    throw new DocNexusError("invalid_params", "document get requires --id");
  }
  const include = options.include?.split(",");
  if (include?.some((item) => !(DOCUMENT_INCLUDES as readonly string[]).includes(item))) {
    throw new DocNexusError("invalid_params", "--include must list source,document,metadata,timeline,template");
  }
  return json(await getManagedRecord(projectRoot, options.id, include as DocumentInclude[] | undefined));
};

const documentRender: CommandHandler = async ({ projectRoot }) => json(await refreshFactViews(projectRoot));

const documentClassify: CommandHandler = async ({ projectRoot, rest }) => {
  requireKnownOptions(rest, ["--id", "--category", "--reason", "--revision"],
    (option) => `unknown document classify option: ${option}`);
  const options = parseOptions(rest);
  if (!options.id || !options.category || !options.reason) {
    throw new DocNexusError("invalid_params", "document classify requires --id, --category and --reason");
  }
  const { id, category, reason, revision } = options;
  return json(await classifyManagedDocument(projectRoot, { id, category, reason, revision }));
};

const documentDelete: CommandHandler = async ({ projectRoot, rest }) => {
  const [force, args] = takeFlag(rest, "--force");
  if (!force) {
    throw new DocNexusError("confirmation_required", "document delete requires --force");
  }
  const options = parseOptions(args);
  const deleted = await deleteManagedDocument(projectRoot, { file_path: options.file, id: options.id, confirm: force });
  await writeConceptIndex(projectRoot);
  return json(deleted);
};

const documentSync: CommandHandler = async ({ projectRoot, rest }) => {
  const options = parseOptions(rest);
  const metadata = options["metadata-file"]
    ? (JSON.parse(await readProjectFile(projectRoot, options["metadata-file"])) as DocNexusMetadata)
    : undefined;
  const result = await syncManagedDocument(projectRoot, { id: options.id, file_path: options.file, metadata });
  await writeConceptIndex(projectRoot);
  return json({ ...result, library_path: libraryRelativePath(result.file_path) });
};

// Retrieval maintenance.

function indexSync(all: boolean): CommandHandler {
  return async ({ projectRoot, rest }) => {
    if (all && !rest.includes("--force")) {
      throw new DocNexusError("confirmation_required", "index rebuild requires --force");
    }
    const result = await syncRetrievalIndex(projectRoot, { all });
    await writeConceptIndex(projectRoot);
    return json(result);
  };
}

const indexStatus: CommandHandler = async ({ projectRoot }) =>
  json({ ...(await inspectRetrievalIndex(projectRoot)), records: await inspectRecords(projectRoot) });

const graphAudit: CommandHandler = async ({ projectRoot }) => json(await auditGraph(projectRoot));

const graphRepair: CommandHandler = async ({ projectRoot, rest }) =>
  json(await repairGraph(projectRoot, { force: rest.includes("--force") }));

const embeddingsInstall: CommandHandler = async ({ projectRoot, rest }) => {
  const [replace, args] = takeFlag(rest, "--replace");
  const options = parseOptions(args);
  if (!options.from) throw new DocNexusError("invalid_params", "embeddings install requires --from");
  return json(await installEmbeddingModel(projectRoot, { sourcePath: await projectContainedPath(projectRoot, options.from), replace }));
};

export const commands: Record<string, CommandDefinition> = {
  protocol: { workspace: false, run: protocol },
  usage: { workspace: false, run: usage },
  init: { workspace: false, run: init },
  reset: { workspace: false, run: reset },
  doctor: { workspace: false, run: doctor },
  skills: { workspace: true, subcommands: { sync: skillsSync, link: skillsLink } },
  status: { workspace: true, run: status },
  concepts: { workspace: true, run: concepts },
  facts: { workspace: true, subcommands: { list: factsList } },
  draft: {
    workspace: true,
    subcommands: { new: draftNew, seal: draftSeal, preview: draftPreview, list: draftList, discard: draftDiscard }
  },
  impact: { workspace: true, run: impact },
  metadata: { workspace: true, subcommands: { validate: metadataValidate } },
  document: {
    workspace: true,
    subcommands: {
      list: documentList,
      query: documentQuery,
      get: documentGet,
      render: documentRender,
      classify: documentClassify,
      delete: documentDelete,
      sync: documentSync,
      add: documentAdd
    }
  },
  index: { workspace: true, subcommands: { sync: indexSync(false), rebuild: indexSync(true), status: indexStatus } },
  graph: { workspace: true, subcommands: { audit: graphAudit, repair: graphRepair } },
  embeddings: { workspace: true, subcommands: { install: embeddingsInstall } },
  search: { workspace: true, run: findCommand("search") },
  recall: { workspace: true, run: findCommand("recall") }
};

/** Resolves the handler for an invocation, or undefined when the command or subcommand is unknown. */
export function resolveCommand(command: string | undefined, subcommand: string | undefined): {
  definition: CommandDefinition;
  handler: CommandHandler | undefined;
} | undefined {
  if (command === undefined || !Object.hasOwn(commands, command)) return undefined;
  const definition = commands[command];
  if (definition.run) return { definition, handler: definition.run };
  const handler = subcommand !== undefined && definition.subcommands && Object.hasOwn(definition.subcommands, subcommand)
    ? definition.subcommands[subcommand]
    : undefined;
  return { definition, handler };
}

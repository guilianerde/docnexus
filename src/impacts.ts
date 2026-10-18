import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DocNexusError, rereadCommand } from "./errors.js";
import { sha256, stableJson } from "./hash.js";
import { isTimestamp } from "./metadata.js";
import { withProjectLock } from "./project-lock.js";
import { assertNoSymbolicLinks, atomicWrite, readIfExists } from "./workspace-io.js";
import { loadWorkspaceSnapshot, type WorkspaceSnapshot } from "./workspace-snapshot.js";
import { normalizeManagedFilePath } from "./workspace-reader.js";

const DIRECTORY = "docnexus/impacts";
const ID = /^impact_[a-f0-9]{16}$/;
const DOCUMENT_ID = /^doc_[a-f0-9]{16}$/;
const VERSION = /^[a-f0-9]{64}$/;
const decisions = ["update", "no_change", "conflict", "unverified"] as const;
const statuses = ["pending", "done", "dismissed"] as const;
export type ImpactStatus = typeof statuses[number];
export type ImpactFilter = ImpactStatus | "needs_review";
export interface ImpactInput {
  source: { id: string; record_version: string };
  scope: string;
  limitations: string;
  pages: Array<{ id: string; file_path: string; record_version: string | null;
    decision: typeof decisions[number]; evidence: string; proposed_action: string }>;
}
interface Basis { record_version: string | null; document_hash: string | null }
interface ImpactCheck { at: string; status: ImpactStatus; reason: string; source: Basis; target: Basis }
interface ImpactRecord {
  schema_version: 1;
  id: string;
  source_path: string;
  created_at: string;
  updated_at: string;
  input: ImpactInput;
  checks: Record<string, ImpactCheck[]>;
}
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const validVersion = (value: unknown) => typeof value === "string" && VERSION.test(value);

export function validateImpactInput(value: unknown): asserts value is ImpactInput {
  const input = value as ImpactInput;
  if (!input || !input.source || !DOCUMENT_ID.test(input.source.id) || !validVersion(input.source.record_version)
    || !nonempty(input.scope) || typeof input.limitations !== "string" || !Array.isArray(input.pages)) {
    throw new DocNexusError("invalid_params", "impact requires a versioned source, scope, limitations and pages");
  }
  const ids = new Set<string>();
  for (const page of input.pages) {
    if (!page || !DOCUMENT_ID.test(page.id) || page.id === input.source.id || ids.has(page.id)
      || !nonempty(page.file_path) || !(decisions as readonly string[]).includes(page.decision)
      || !nonempty(page.evidence) || !nonempty(page.proposed_action)
      || !(validVersion(page.record_version) || (page.decision === "unverified" && page.record_version === null))) {
      throw new DocNexusError("invalid_params", "impact pages require unique related document ids, paths, decisions, evidence, actions and read versions; only unverified pages allow null versions");
    }
    ids.add(page.id);
  }
}

async function impactPath(root: string, id: string) {
  if (!ID.test(id)) throw new DocNexusError("invalid_params", "invalid impact id");
  const relative = join(DIRECTORY, `${id}.json`);
  await assertNoSymbolicLinks(await realpath(root), relative);
  return join(root, relative);
}

async function readRecord(root: string, id: string): Promise<ImpactRecord | undefined> {
  const text = await readIfExists(await impactPath(root, id));
  if (text === undefined) return undefined;
  try {
    const record = JSON.parse(text) as ImpactRecord;
    validateImpactInput(record.input);
    const basisValid = (basis: Basis) => basis && ((validVersion(basis.record_version) && validVersion(basis.document_hash))
      || (basis.record_version === null && basis.document_hash === null));
    if (record.schema_version !== 1 || record.id !== id || id !== `impact_${sha256(stableJson(record.input)).slice(0, 16)}` || !nonempty(record.source_path)
      || !isTimestamp(record.created_at) || !isTimestamp(record.updated_at)
      || !record.input.pages.every(page => Array.isArray(record.checks?.[page.id]) && record.checks[page.id].length > 0
        && record.checks[page.id].every(check => isTimestamp(check.at) && statuses.includes(check.status)
          && nonempty(check.reason) && basisValid(check.source) && basisValid(check.target)))) throw new Error("invalid record");
    return record;
  } catch {
    throw new DocNexusError("text_integrity_error", `invalid impact record: ${DIRECTORY}/${id}.json; restore or review the file`);
  }
}

function basis(snapshot: WorkspaceSnapshot, id: string): Basis {
  return snapshot.records.some(record => record.id === id)
    ? { record_version: snapshot.recordVersion(id), document_hash: sha256(snapshot.renderDocument(id).document) }
    : { record_version: null, document_hash: null };
}

function view(record: ImpactRecord, snapshot: WorkspaceSnapshot) {
  const source = basis(snapshot, record.input.source.id);
  const pages = record.input.pages.map(page => {
    const history = record.checks[page.id], checked = history.at(-1)!;
    const current = basis(snapshot, page.id);
    const needsReview = stableJson([source, current]) !== stableJson([checked.source, checked.target]);
    return { ...page, recorded_status: checked.status, status: needsReview ? "needs_review" as const : checked.status,
      needs_review: needsReview, current_record_version: current.record_version, history };
  });
  return { id: record.id, impact_path: `${DIRECTORY}/${record.id}.json`, created_at: record.created_at, updated_at: record.updated_at,
    source: { ...record.input.source, file_path: record.source_path, current_record_version: source.record_version },
    scope: record.input.scope, limitations: record.input.limitations, pages,
    revision: sha256(stableJson([record, source, pages.map(page => basis(snapshot, page.id))])) };
}

/** Save acknowledgement: per-page state only. Evidence, proposed actions and history stay behind `impact get`. */
function summary(full: ReturnType<typeof view>) {
  return { id: full.id, impact_path: full.impact_path, created_at: full.created_at, updated_at: full.updated_at,
    source: { id: full.source.id, file_path: full.source.file_path },
    pages: full.pages.map(page => ({ id: page.id, file_path: page.file_path, decision: page.decision, status: page.status, needs_review: page.needs_review })),
    revision: full.revision, details: ["impact", "get", "--id", full.id] };
}

/** Save review context separately from canonical knowledge. Equal submissions retain their existing progress. */
export async function saveImpact(root: string, value: unknown) {
  validateImpactInput(value);
  const input = value;
  return withProjectLock(root, async () => {
    const id = `impact_${sha256(stableJson(input)).slice(0, 16)}`;
    const prior = await readRecord(root, id);
    const snapshot = await loadWorkspaceSnapshot(root);
    if (prior) {
      if (stableJson(prior.input) !== stableJson(input)) throw new DocNexusError("text_integrity_error", "impact identity does not match its saved input");
      return { result: "impact_exists" as const, ...summary(view(prior, snapshot)) };
    }
    const source = snapshot.records.find(record => record.id === input.source.id);
    if (!source || snapshot.recordVersion(source.id) !== input.source.record_version) {
      throw new DocNexusError("target_changed", "impact source changed; reread the source and reconsider related-page decisions before saving",
        undefined, source ? { command: rereadCommand(source.id) } : undefined);
    }
    for (const page of input.pages) {
      if (await normalizeManagedFilePath(root, page.file_path) !== page.file_path) throw new DocNexusError("invalid_params", "impact page requires a canonical library-relative Markdown path");
      const target = snapshot.records.find(record => record.id === page.id);
      if (target && target.file_path !== page.file_path) throw new DocNexusError("invalid_params", "impact path does not match the related document identity");
      if (page.record_version !== null && (!target || snapshot.recordVersion(page.id) !== page.record_version)) {
        throw new DocNexusError("target_changed", `related page changed: ${page.file_path}; reread and reconsider its impact`,
          undefined, target ? { command: rereadCommand(target.id) } : undefined);
      }
    }
    const at = new Date().toISOString();
    const record: ImpactRecord = { schema_version: 1, id, source_path: source.file_path, created_at: at, updated_at: at, input,
      checks: Object.fromEntries(input.pages.map(page => [page.id, [{ at,
        status: page.decision === "no_change" ? "done" as const : "pending" as const,
        reason: page.evidence, source: basis(snapshot, source.id), target: basis(snapshot, page.id) }]])) };
    await atomicWrite(await impactPath(root, id), `${stableJson(record)}\n`);
    return { result: "impact_saved" as const, ...summary(view(record, snapshot)) };
  });
}

export async function getImpact(root: string, id: string) {
  return withProjectLock(root, async () => {
    const record = await readRecord(root, id);
    if (!record) throw new DocNexusError("impact_not_found", "impact record not found");
    return view(record, await loadWorkspaceSnapshot(root));
  });
}

export async function listImpacts(root: string, status?: string) {
  if (status !== undefined && ![...statuses, "needs_review"].includes(status)) throw new DocNexusError("invalid_params", "impact status must be pending, done, dismissed or needs_review");
  return withProjectLock(root, async () => {
    await assertNoSymbolicLinks(await realpath(root), DIRECTORY);
    const entries = await readdir(join(root, DIRECTORY)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const snapshot = await loadWorkspaceSnapshot(root);
    const impacts: ReturnType<typeof view>[] = [];
    for (const file of entries.sort()) {
      if (!file.endsWith(".json")) continue;
      const record = await readRecord(root, file.slice(0, -5));
      if (!record) continue;
      const result = view(record, snapshot);
      if (status !== undefined) result.pages = result.pages.filter(page => page.status === status);
      if (status === undefined || result.pages.length) impacts.push(result);
    }
    return { impacts };
  });
}

/** Acknowledging a fresh view appends history; no document content or facts are changed. */
export async function setImpactStatus(root: string, input: { id: string; document: string; status: string; reason: string; revision: string }) {
  if (!(statuses as readonly string[]).includes(input.status) || !nonempty(input.reason) || !validVersion(input.revision)) {
    throw new DocNexusError("invalid_params", "impact set requires pending|done|dismissed, a reason and the revision from impact get");
  }
  return withProjectLock(root, async () => {
    const record = await readRecord(root, input.id);
    if (!record) throw new DocNexusError("impact_not_found", "impact record not found");
    const snapshot = await loadWorkspaceSnapshot(root);
    const current = view(record, snapshot);
    if (current.revision !== input.revision) throw new DocNexusError("impact_changed", "impact or document context changed; reread the impact and affected documents before updating its status");
    const page = record.input.pages.find(page => page.id === input.document);
    if (!page) throw new DocNexusError("invalid_params", "document is not a page in this impact record");
    const source = basis(snapshot, record.input.source.id), target = basis(snapshot, page.id);
    if (input.status === "done" && (!source.record_version || !target.record_version)) {
      throw new DocNexusError("invalid_params", "missing source or related document cannot be marked done; review and dismiss or leave pending");
    }
    const history = record.checks[page.id], last = history.at(-1)!;
    const check = { status: input.status as ImpactStatus, reason: input.reason, source, target };
    if (stableJson(check) === stableJson({ status: last.status, reason: last.reason, source: last.source, target: last.target })) {
      return { result: "impact_unchanged" as const, ...current };
    }
    const at = new Date().toISOString();
    history.push({ at, ...check }); record.updated_at = at;
    await atomicWrite(await impactPath(root, record.id), `${stableJson(record)}\n`);
    return { result: "impact_updated" as const, ...view(record, snapshot) };
  });
}

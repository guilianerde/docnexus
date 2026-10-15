import { DocNexusError, errorEnvelope, PROTOCOL_VERSION, type ErrorEnvelope } from "./errors.js";
import { checkEmbeddingRuntime, type DefaultEmbeddingRuntimeCheck } from "./embedder-default.js";
import { checkPostgresVectorIndex } from "./postgres-store.js";
import { inspectRetrievalIndex, type RetrievalIndexState } from "./retrieval-index.js";
import { resolve } from "node:path";
import { workspacePath } from "./layout.js";
import { inspectRecords, type RecordsState } from "./managed-documents.js";
import { requireInitializedProject } from "./project.js";
import { inspectSkills, type SkillsState } from "./skills.js";

interface Check {
  ok: boolean;
  message?: string;
  skipped?: boolean;
}

export interface DoctorOutput {
  protocol_version: 1;
  issues: ErrorEnvelope[];
  result: "ok" | "issues_found";
  checked_at: string;
  checks: {
    node: Check & { version: string };
    project: Check & { initialized: boolean; project_root: string; workspace_path?: string };
    skills: Check & Partial<SkillsState>;
    records: Check & Partial<RecordsState>;
    index: Check & Partial<RetrievalIndexState>;
    database: Check;
    embedding: Check & Partial<DefaultEmbeddingRuntimeCheck>;
  };
  recommendations: string[];
}

/** Diagnose text, derived stores and the local model without repairing memory or indexes. */
export async function runDoctor(projectRoot: string): Promise<DoctorOutput> {
  const root = resolve(projectRoot);
  const node = { ok: Number(process.versions.node.split(".")[0]) >= 22, version: process.version };
  const recommendations: string[] = [];
  const issues: ErrorEnvelope[] = [];
  const project: DoctorOutput["checks"]["project"] = { ok: false, initialized: false, project_root: root };
  let skills: DoctorOutput["checks"]["skills"] = { ok: false, skipped: true };
  let records: DoctorOutput["checks"]["records"] = { ok: false, skipped: true };
  let index: DoctorOutput["checks"]["index"] = { ok: false, skipped: true };
  let database: Check = { ok: false, skipped: true };
  let embedding: DoctorOutput["checks"]["embedding"] = { ok: false, skipped: true };
  try {
    await requireInitializedProject(root);
    Object.assign(project, { ok: true, initialized: true, workspace_path: workspacePath(root) });
  } catch (error) {
    issues.push(errorEnvelope(error, root));
    project.message = error instanceof Error ? error.message : String(error);
    recommendations.push(`Run "docnexus init" in ${root}.`);
  }
  if (project.ok) {
    const state = await inspectSkills(root);
    skills = { ...state, ok: state.missing.length === 0 && !state.outdated };
    if (!skills.ok) recommendations.push("Run docnexus skills sync to restore the project skills.");
    if (Object.values(state.links).every((link) => link.missing.length > 0)) {
      skills.message = "skills are not linked into any agent directory";
      recommendations.push("Run docnexus skills link --target claude (or codex, all) so your agent can discover the skills.");
    }
    try {
      const state = await inspectRecords(root);
      records = state;
      if (state.edited.length > 0) {
        recommendations.push("Adopt hand-edited library files with docnexus document sync --id <id> after reviewing them.");
      }
      if (state.missing_library.length > 0) {
        recommendations.push("Restore missing library files from Git or a backup.");
      }
      if (state.invalid_records.length > 0) {
        recommendations.push("Restore damaged record files from Git or a backup; doctor does not rewrite them.");
      }
    } catch (error) {
      records = { ok: false, message: error instanceof Error ? error.message : String(error) };
      recommendations.push("Restore damaged record files from Git or a backup; doctor does not rewrite them.");
    }
  }
  if (project.ok) {
    try {
      const state = await inspectRetrievalIndex(root);
      index = { ...state, ok: state.in_sync };
      if (!state.in_sync) recommendations.push(state.schema_status === "unsupported" ? "Use a DocNexus release compatible with the stored projection version; canonical text remains readable." : "Run docnexus index sync to rebuild derived state from current text.");
      database = state.available ? await checkPostgresVectorIndex(root) : state.record_count === 0 && !state.message ? { ok: true, skipped: true, message: "retrieval database is created on first sync" } : { ok: false, message: state.message ?? "retrieval store is missing" };
      if (!database.ok && state.available && state.schema_status === "current") recommendations.push("Run docnexus graph repair --force, or index rebuild --force if document projections are damaged.");
    } catch (error) {
      index = { ok: false, message: error instanceof Error ? error.message : String(error) };
      recommendations.push("Inspect the derived stores and rebuild them from verified text.");
    }
    embedding = await checkEmbeddingRuntime(root);
    if (!embedding.ok) recommendations.push("Restore the bundled local model or install a project model override, then rerun doctor.");
  }
  if (!node.ok) recommendations.push("Install Node.js 22 or newer.");
  const finding = (code: ConstructorParameters<typeof DocNexusError>[0], message: string, details?: Record<string, unknown>) => issues.push(errorEnvelope(new DocNexusError(code, message, details), root));
  if (!node.ok) finding("node_unsupported", "Node.js does not meet the supported runtime version.");
  if (project.ok) {
    if (!skills.ok) finding("skills_outdated", skills.message ?? "Project skills are missing or outdated.");
    if (!records.ok) finding("text_integrity_error", records.message ?? "Canonical text has edits, missing files or damaged records.", { edited: records.edited, missing_library: records.missing_library, invalid_records: records.invalid_records });
    else if (!index.ok) finding(index.schema_status === "unsupported" ? "index_schema_incompatible" : index.schema_status === "legacy" ? "index_outdated" : index.message ? "index_unavailable" : "index_outdated", index.message ?? "The retrieval projection is not synchronized.");
    if (!database.ok && index.available && index.schema_status === "current") finding("index_unavailable", database.message ?? "The vector index is unavailable.");
    if (!embedding.ok) finding("embedding_failed", embedding.message ?? "The offline model is unavailable.");
  }
  return {
    protocol_version: PROTOCOL_VERSION, issues,
    result: [node, project, skills, records, index, database, embedding].every((check) => check.ok) ? "ok" : "issues_found",
    checked_at: new Date().toISOString(),
    checks: { node, project, skills, records, index, database, embedding },
    recommendations
  };
}

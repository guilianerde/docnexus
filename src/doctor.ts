import { resolve } from "node:path";
import { checkEmbeddingRuntime } from "./embedder-default.js";
import { checkLadybugVectorIndex } from "./ladybug-store.js";
import { workspacePath } from "./layout.js";
import { getManagedSchemaTables, type IndexDrift, inspectIndex } from "./managed-documents.js";
import { requireInitializedProject } from "./project.js";
import { inspectSkills, type SkillsState } from "./skills.js";

type EmbeddingCheck = Awaited<ReturnType<typeof checkEmbeddingRuntime>>;

interface BaseCheck {
  ok: boolean;
  message?: string;
  skipped?: boolean;
}

interface NodeCheck extends BaseCheck {
  version: string;
  sqlite_available: boolean;
}

interface ProjectCheck extends BaseCheck {
  initialized: boolean;
  project_root: string;
  workspace_path?: string;
}

interface SkillsCheck extends BaseCheck, Partial<SkillsState> {}

interface IndexCheck extends BaseCheck, Partial<IndexDrift> {}

interface SqliteCheck extends BaseCheck {
  tables?: string[];
}

interface LadybugCheck extends BaseCheck {
  vector_index_ok?: boolean;
}

export interface DoctorDependencies {
  checkLadybugVectorIndex: typeof checkLadybugVectorIndex;
  checkEmbeddingRuntime: (projectRoot?: string) => Promise<EmbeddingCheck>;
}

export interface DoctorOutput {
  result: "ok" | "issues_found";
  checked_at: string;
  checks: {
    node: NodeCheck;
    project: ProjectCheck;
    skills: SkillsCheck;
    sqlite: SqliteCheck;
    index: IndexCheck;
    ladybug: LadybugCheck;
    embedding: EmbeddingCheck;
  };
  recommendations: string[];
}

const defaultDependencies: DoctorDependencies = {
  checkLadybugVectorIndex,
  checkEmbeddingRuntime
};

export async function runDoctor(
  projectRoot: string,
  dependencies: DoctorDependencies = defaultDependencies
): Promise<DoctorOutput> {
  const root = resolve(projectRoot);
  const node = await checkNodeRuntime();
  const project = await checkProject(root);
  const skills = project.ok ? await checkSkills(root) : skippedCheck("project is not initialized");
  const sqlite = project.ok ? await checkSqlite(root) : skippedCheck("project is not initialized");
  const index = project.ok && sqlite.ok ? await checkIndex(root) : skippedCheck("project or SQLite store is unavailable");
  const ladybug = project.ok ? await checkLadybug(root, dependencies) : skippedCheck("project is not initialized");
  const embedding = await dependencies.checkEmbeddingRuntime(root);
  const recommendations = buildRecommendations(root, { node, project, skills, sqlite, index, ladybug, embedding });
  const allOk = [node, project, skills, sqlite, index, ladybug, embedding].every((check) => check.ok);

  return {
    result: allOk ? "ok" : "issues_found",
    checked_at: new Date().toISOString(),
    checks: {
      node,
      project,
      skills,
      sqlite,
      index,
      ladybug,
      embedding
    },
    recommendations
  };
}

async function checkNodeRuntime(): Promise<NodeCheck> {
  try {
    await import("node:sqlite");
    return {
      ok: true,
      version: process.version,
      sqlite_available: true
    };
  } catch (error) {
    return {
      ok: false,
      version: process.version,
      sqlite_available: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

async function checkProject(projectRoot: string): Promise<ProjectCheck> {
  try {
    const root = await requireInitializedProject(projectRoot);
    return {
      ok: true,
      initialized: true,
      project_root: root,
      workspace_path: workspacePath(root)
    };
  } catch (error) {
    return {
      ok: false,
      initialized: false,
      project_root: projectRoot,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

async function checkSkills(projectRoot: string): Promise<SkillsCheck> {
  const state = await inspectSkills(projectRoot);
  const linked = Object.values(state.links).some((link) => link.missing.length === 0);
  return {
    ok: state.missing.length === 0 && !state.outdated,
    ...state,
    message: state.missing.length > 0
      ? `missing skills: ${state.missing.join(", ")}`
      : state.outdated
        ? `skills were synced from ${state.version ?? "an unknown version"}; package is ${state.package_version}`
        : linked ? undefined : "skills are not linked into any agent directory"
  };
}

async function checkIndex(projectRoot: string): Promise<IndexCheck> {
  try {
    const drift = await inspectIndex(projectRoot);
    const problems = [
      drift.in_sync ? undefined : "index is out of sync with docnexus/records",
      drift.edited.length > 0 ? `${drift.edited.length} library file(s) edited after ingestion` : undefined,
      drift.missing_library.length > 0 ? `${drift.missing_library.length} library file(s) missing` : undefined
    ].filter(Boolean);
    return { ok: problems.length === 0, ...drift, message: problems.length > 0 ? problems.join("; ") : undefined };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function checkSqlite(projectRoot: string): Promise<SqliteCheck> {
  try {
    const tables = await getManagedSchemaTables(projectRoot);
    const missing = ["documents", "file_chunks"].filter((table) => !tables.includes(table));
    return {
      ok: missing.length === 0,
      tables,
      message: missing.length > 0 ? `missing SQLite tables: ${missing.join(", ")}` : undefined
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

async function checkLadybug(projectRoot: string, dependencies: DoctorDependencies): Promise<LadybugCheck> {
  const health = await dependencies.checkLadybugVectorIndex(projectRoot);
  return {
    ok: health.ok,
    vector_index_ok: health.ok,
    message: health.message
  };
}

function skippedCheck(message: string): SqliteCheck & LadybugCheck {
  return {
    ok: false,
    skipped: true,
    message
  };
}

function buildRecommendations(
  projectRoot: string,
  checks: {
    node: NodeCheck;
    project: ProjectCheck;
    skills: SkillsCheck;
    sqlite: SqliteCheck;
    index: IndexCheck;
    ladybug: LadybugCheck;
    embedding: EmbeddingCheck;
  }
): string[] {
  const recommendations: string[] = [];
  if (!checks.node.sqlite_available) {
    recommendations.push("Install a Node.js version that supports node:sqlite.");
  }
  if (!checks.project.initialized) {
    recommendations.push(`Run "docnexus init" in ${projectRoot}.`);
  }
  if (checks.index.in_sync === false) {
    recommendations.push("Run docnexus index sync to rebuild derived state from docnexus/records.");
  }
  if (checks.index.edited && checks.index.edited.length > 0) {
    recommendations.push(`Adopt hand-edited library files with docnexus document sync --id <id> (${checks.index.edited.join(", ")}).`);
  }
  if (checks.skills.ok === false && !checks.skills.skipped) {
    recommendations.push("Run docnexus skills sync to restore the project skills.");
  }
  if (checks.skills.links && Object.values(checks.skills.links).every((link) => link.missing.length > 0)) {
    recommendations.push("Run docnexus skills link --target claude (or codex, all) so your agent can discover the skills.");
  }
  if (checks.sqlite.ok === false && !checks.sqlite.skipped) {
    recommendations.push("Run docnexus reset --force and docnexus init if the SQLite store cannot be repaired.");
  }
  if (checks.ladybug.ok === false && !checks.ladybug.skipped) {
    recommendations.push("Run docnexus graph repair --force, then docnexus index rebuild --force if graph issues remain.");
  }
  if (!checks.embedding.ok && checks.embedding.provider === "local-transformers") {
    recommendations.push("Install or cache the DocNexus embedding model locally, then rerun docnexus doctor.");
  }
  return recommendations;
}

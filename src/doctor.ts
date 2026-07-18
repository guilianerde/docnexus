import { resolve } from "node:path";
import { checkEmbeddingRuntime } from "./embedder-default.js";
import { checkLadybugVectorIndex } from "./ladybug-store.js";
import { getManagedSchemaTables, storePath } from "./managed-documents.js";
import { requireInitializedProject } from "./project.js";

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
  store_path?: string;
}

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
    sqlite: SqliteCheck;
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
  const sqlite = project.ok ? await checkSqlite(root) : skippedCheck("project is not initialized");
  const ladybug = project.ok ? await checkLadybug(root, dependencies) : skippedCheck("project is not initialized");
  const embedding = await dependencies.checkEmbeddingRuntime(root);
  const recommendations = buildRecommendations(root, { node, project, sqlite, ladybug, embedding });
  const allOk = [node, project, sqlite, ladybug, embedding].every((check) => check.ok);

  return {
    result: allOk ? "ok" : "issues_found",
    checked_at: new Date().toISOString(),
    checks: {
      node,
      project,
      sqlite,
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
      store_path: storePath(root)
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
    sqlite: SqliteCheck;
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

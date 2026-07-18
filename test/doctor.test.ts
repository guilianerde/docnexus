import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor, type DoctorDependencies } from "../src/doctor.js";
import { EMBEDDING_DIMENSION } from "../src/embedding-config.js";
import { initializeProject } from "../src/project.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-doctor-"));
  roots.push(root);
  return root;
}

function healthyDependencies(): DoctorDependencies {
  return {
    checkLadybugVectorIndex: async () => ({ ok: true }),
    checkEmbeddingRuntime: async () => ({
      ok: true,
      provider: "local-transformers",
      model: "BAAI/bge-small-zh-v1.5",
      dimension: EMBEDDING_DIMENSION,
      local_only: true,
      remote_allowed: false
    })
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runDoctor", () => {
  it("reports an uninitialized project without throwing", async () => {
    const projectRoot = await makeRoot();

    const output = await runDoctor(projectRoot, healthyDependencies());

    expect(output.result).toBe("issues_found");
    expect(output.checks.project).toMatchObject({
      ok: false,
      initialized: false,
      project_root: projectRoot
    });
    expect(output.recommendations).toContain(`Run "docnexus init" in ${projectRoot}.`);
  });

  it("reports a healthy initialized local runtime", async () => {
    const projectRoot = await makeRoot();
    await initializeProject(projectRoot);

    const output = await runDoctor(projectRoot, healthyDependencies());

    expect(output).toMatchObject({
      result: "ok",
      checks: {
        node: {
          ok: true,
          sqlite_available: true
        },
        project: {
          ok: true,
          initialized: true,
          project_root: projectRoot
        },
        sqlite: {
          ok: true,
          tables: ["documents", "file_chunks"]
        },
        ladybug: {
          ok: true
        },
        embedding: {
          ok: true,
          provider: "local-transformers",
          local_only: true,
          remote_allowed: false
        }
      },
      recommendations: []
    });
  });

  it("keeps embedding failures actionable", async () => {
    const projectRoot = await makeRoot();
    await initializeProject(projectRoot);
    const dependencies = healthyDependencies();
    dependencies.checkEmbeddingRuntime = async () => ({
      ok: false,
      provider: "local-transformers",
      model: "BAAI/bge-small-zh-v1.5",
      dimension: EMBEDDING_DIMENSION,
      local_only: true,
      remote_allowed: false,
      message: "local model files were not found"
    });

    const output = await runDoctor(projectRoot, dependencies);

    expect(output.result).toBe("issues_found");
    expect(output.checks.embedding).toMatchObject({
      ok: false,
      local_only: true,
      remote_allowed: false,
      message: "local model files were not found"
    });
    expect(output.recommendations).toContain("Install or cache the DocNexus embedding model locally, then rerun docnexus doctor.");
  });
});

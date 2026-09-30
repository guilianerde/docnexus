import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EMBEDDING_MODEL,
  bundledEmbeddingModelsPath,
  installEmbeddingModel,
  projectEmbeddingModelsPath,
  resolveEmbeddingModelsRoot
} from "../src/embedding-models.js";
import { initializeProject } from "../src/project.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-embedding-models-"));
  roots.push(root);
  return root;
}

async function makeModelDir(root: string, onnxFile = "model_quantized.onnx"): Promise<string> {
  const modelDir = join(root, "source-model");
  await mkdir(join(modelDir, "onnx"), { recursive: true });
  await writeFile(join(modelDir, "config.json"), "{}");
  await writeFile(join(modelDir, "tokenizer.json"), "{}");
  await writeFile(join(modelDir, "onnx", onnxFile), "onnx");
  return modelDir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("embedding model assets", () => {
  it("installs a local model directory into the initialized project", async () => {
    const projectRoot = await makeRoot();
    await initializeProject(projectRoot);
    const sourcePath = await makeModelDir(projectRoot);

    const output = await installEmbeddingModel(projectRoot, { sourcePath, replace: false });

    expect(output).toEqual({
      model: DEFAULT_EMBEDDING_MODEL,
      installed_path: join(projectRoot, "docnexus", "store", "models", "BAAI", "bge-small-zh-v1.5"),
      replaced: false
    });
    await expect(stat(join(output.installed_path, "tokenizer.json"))).resolves.toBeDefined();
    await expect(readFile(join(output.installed_path, "onnx", "model_quantized.onnx"), "utf8")).resolves.toBe("onnx");
    expect(resolveEmbeddingModelsRoot(projectRoot)).toBe(projectEmbeddingModelsPath(projectRoot));
  });

  it("requires replace before overwriting an installed project model", async () => {
    const projectRoot = await makeRoot();
    await initializeProject(projectRoot);
    const sourcePath = await makeModelDir(projectRoot);
    await installEmbeddingModel(projectRoot, { sourcePath, replace: false });

    await expect(installEmbeddingModel(projectRoot, { sourcePath, replace: false })).rejects.toThrow(
      "embedding model already installed"
    );

    await expect(installEmbeddingModel(projectRoot, { sourcePath, replace: true })).resolves.toMatchObject({
      model: DEFAULT_EMBEDDING_MODEL,
      replaced: true
    });
  });

  it("rejects incomplete model directories", async () => {
    const projectRoot = await makeRoot();
    await initializeProject(projectRoot);
    const sourcePath = join(projectRoot, "incomplete-model");
    await mkdir(sourcePath, { recursive: true });
    await writeFile(join(sourcePath, "tokenizer.json"), "{}");

    await expect(installEmbeddingModel(projectRoot, { sourcePath, replace: false })).rejects.toThrow(
      "embedding model source is incomplete"
    );
  });

  it("rejects an install without the q8 model file required by the runtime", async () => {
    const projectRoot = await makeRoot();
    await initializeProject(projectRoot);
    const sourcePath = await makeModelDir(projectRoot, "model.onnx");

    await expect(installEmbeddingModel(projectRoot, { sourcePath, replace: false })).rejects.toThrow(
      "onnx/model_quantized.onnx"
    );
  });

  it("ignores an incomplete project override when resolving the model root", async () => {
    const projectRoot = await makeRoot();
    await initializeProject(projectRoot);
    const override = join(projectEmbeddingModelsPath(projectRoot), ...DEFAULT_EMBEDDING_MODEL.split("/"));
    await mkdir(join(override, "onnx"), { recursive: true });
    await writeFile(join(override, "config.json"), "{}");
    await writeFile(join(override, "tokenizer.json"), "{}");
    await writeFile(join(override, "onnx", "model.onnx"), "onnx");

    expect(resolveEmbeddingModelsRoot(projectRoot)).toBe(bundledEmbeddingModelsPath());
  });
});

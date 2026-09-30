import { cp, mkdir, rm, stat } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_EMBEDDING_MODEL } from "./embedding-config.js";
import { projectModelsPath } from "./layout.js";

export { DEFAULT_EMBEDDING_MODEL };

export interface InstallEmbeddingModelInput {
  sourcePath: string;
  replace: boolean;
  model?: string;
}

export interface InstallEmbeddingModelOutput {
  model: string;
  installed_path: string;
  replaced: boolean;
}

export function projectEmbeddingModelsPath(projectRoot: string): string {
  return projectModelsPath(resolve(projectRoot));
}

export function bundledEmbeddingModelsPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const compiledPath = resolve(moduleDirectory, "../../models");
  const sourcePath = resolve(moduleDirectory, "../models");
  return hasCompleteModelSync(compiledPath, DEFAULT_EMBEDDING_MODEL) ? compiledPath : sourcePath;
}

export function resolveEmbeddingModelsRoot(projectRoot?: string, model = DEFAULT_EMBEDDING_MODEL): string {
  const projectRootPath = projectRoot ? projectEmbeddingModelsPath(projectRoot) : undefined;
  if (projectRootPath && hasCompleteModelSync(projectRootPath, model)) {
    return projectRootPath;
  }

  const bundledPath = bundledEmbeddingModelsPath();
  if (hasCompleteModelSync(bundledPath, model)) {
    return bundledPath;
  }

  return projectRootPath ?? bundledPath;
}

export async function installEmbeddingModel(
  projectRoot: string,
  input: InstallEmbeddingModelInput
): Promise<InstallEmbeddingModelOutput> {
  const model = input.model ?? DEFAULT_EMBEDDING_MODEL;
  const source = resolve(input.sourcePath);
  await assertCompleteModelDirectory(source);

  const destination = modelPath(projectEmbeddingModelsPath(projectRoot), model);
  const existed = existsSync(destination);
  if (existed && !input.replace) {
    throw new Error("embedding model already installed; embeddings install requires --replace");
  }

  if (existed) {
    await rm(destination, { recursive: true, force: true });
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });

  return { model, installed_path: destination, replaced: existed };
}

function modelPath(modelsRoot: string, model: string): string {
  return join(modelsRoot, ...model.split("/"));
}

async function assertCompleteModelDirectory(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isDirectory()) {
    throw new Error("embedding model source must be a directory");
  }

  const requiredFiles = ["config.json", "tokenizer.json", join("onnx", "model_quantized.onnx")];
  const missingRequiredFile = await Promise.all(
    requiredFiles.map(async (file) => {
      const fileInfo = await stat(join(path, file)).catch(() => undefined);
      return fileInfo?.isFile() ? undefined : file;
    })
  );
  if (missingRequiredFile.some(Boolean)) {
    throw new Error(
      "embedding model source is incomplete; expected config.json, tokenizer.json, and onnx/model_quantized.onnx"
    );
  }
}

function hasCompleteModelSync(modelsRoot: string, model: string): boolean {
  const root = modelPath(modelsRoot, model);
  try {
    return statSync(join(root, "config.json")).isFile()
      && statSync(join(root, "tokenizer.json")).isFile()
      && statSync(join(root, "onnx", "model_quantized.onnx")).isFile();
  } catch {
    return false;
  }
}

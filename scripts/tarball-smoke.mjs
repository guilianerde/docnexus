#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const smokeRoot = await mkdtemp(join(tmpdir(), "docnexus-tarball-smoke-"));
const packDirectory = join(smokeRoot, "pack");
const projectDirectory = join(smokeRoot, "project");
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const sourceManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const packageNameParts = sourceManifest.name.split("/");

try {
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(projectDirectory, { recursive: true })
  ]);

  const packed = await run(npmExecutable, ["pack", "--json", "--pack-destination", packDirectory], {
    cwd: repositoryRoot
  });
  const [{ filename }] = JSON.parse(packed.stdout);
  if (!filename) {
    throw new Error("npm pack did not report a tarball filename");
  }

  const tarballPath = join(packDirectory, filename);
  await run(
    npmExecutable,
    ["install", "--no-audit", "--no-fund", "--package-lock=false", "--prefix", projectDirectory, tarballPath],
    { cwd: smokeRoot }
  );

  const packageDirectory = join(projectDirectory, "node_modules", ...packageNameParts);
  const cliPath = join(projectDirectory, "node_modules", ".bin", process.platform === "win32" ? "docnexus.cmd" : "docnexus");
  const installedPackagePath = await realpath(packageDirectory);
  const installedCliPath = await realpath(cliPath);
  const workspacePath = await realpath(repositoryRoot);

  if (installedPackagePath.startsWith(`${workspacePath}/`)) {
    throw new Error(`tarball package unexpectedly resolves inside the workspace: ${installedPackagePath}`);
  }
  if (!installedCliPath.startsWith(`${installedPackagePath}/`)) {
    throw new Error(`installed docnexus bin does not resolve into the tarball package: ${installedCliPath}`);
  }

  await verifyPackageContents(packageDirectory);

  const cliEnvironment = { ...process.env, DOCNEXUS_EMBEDDER: "hash" };
  delete cliEnvironment.NODE_PATH;

  const initialized = await runJson(cliPath, ["init", "--agent", "codex"], projectDirectory, cliEnvironment);
  assert(initialized.initialized === true, "init did not report an initialized project");
  assert(initialized.workspace === join(await realpath(projectDirectory), "docnexus"), "init did not create the docnexus workspace");
  await stat(join(projectDirectory, "docnexus", "skills", "docnexus", "SKILL.md"));
  await stat(join(projectDirectory, ".agents", "skills", "docnexus", "SKILL.md"));

  const doctor = await runJson(cliPath, ["doctor"], projectDirectory, cliEnvironment);
  assert(doctor.checks?.project?.initialized === true, "doctor did not recognize the initialized project");
  assert(doctor.checks?.node?.sqlite_available === true, "doctor did not detect node:sqlite");

  const draft = await runJson(cliPath, ["draft", "new", "--slug", "smoke"], projectDirectory, cliEnvironment);
  await Promise.all([
    writeFile(join(projectDirectory, draft.artifacts.source), "The installed DocNexus tarball provides local project memory."),
    writeFile(
      join(projectDirectory, draft.artifacts.document),
      "# Installed package\n\nThe installed DocNexus tarball provides local project memory."
    ),
    writeFile(
      join(projectDirectory, draft.artifacts.metadata),
      JSON.stringify({
        title: "Installed package smoke test",
        summary: "Verifies document storage and recall through the CLI installed from the release tarball.",
        tags: ["release", "smoke"],
        entities: [
          {
            name: "DocNexus tarball",
            type: "component",
            description: "The npm artifact installed and executed by the release smoke test."
          }
        ],
        relationships: []
      })
    )
  ]);

  const sealed = await runJson(
    cliPath,
    ["draft", "seal", "--id", draft.draft_id, "--file", "release/smoke.md"],
    projectDirectory,
    cliEnvironment
  );
  assert(sealed.result === "draft_ready", "draft seal did not report a ready draft");

  const added = await runJson(cliPath, ["document", "add", "--draft", draft.draft_id], projectDirectory, cliEnvironment);
  assert(added.operation === "created", "document add did not create the managed document");

  const listed = await runJson(cliPath, ["document", "list"], projectDirectory, cliEnvironment);
  assert(listed.records?.[0]?.id === added.id, "project-local document list did not find the document");

  const recalled = await runJson(
    cliPath,
    ["recall", "installed DocNexus tarball", "--limit", "1"],
    projectDirectory,
    cliEnvironment
  );
  assert(recalled.results?.length === 1, "recall did not return the installed-package document");
  assert(
    recalled.context_groups?.[0]?.document?.path === "release/smoke.md",
    "recall did not cite the managed document from the smoke project"
  );

  process.stdout.write(`Tarball smoke test passed: ${filename}\n`);
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}

async function verifyPackageContents(packageDirectory) {
  const requiredFiles = [
    "README.md",
    "README.zh-CN.md",
    "CHANGELOG.md",
    "LICENSE",
    "SECURITY.md",
    "docs/README.md",
    "docs/architecture/overview.zh-CN.md",
    "docs/product/mvp.zh-CN.md",
    "docs/product/mvp.en.md",
    "docs/roadmap/current.zh-CN.md",
    "docs/operations/release-checklist.md",
    "skills/docnexus/SKILL.md",
    "skills/docnexus-extract/SKILL.md",
    "skills/docnexus-ingest/SKILL.md",
    "skills/docnexus-recall/SKILL.md",
    "skills/docnexus-library/SKILL.md",
    "skills/docnexus-maintain/SKILL.md",
    "models/README.md",
    "models/BAAI/bge-small-zh-v1.5/README.model.md",
    "models/BAAI/bge-small-zh-v1.5/config.json",
    "models/BAAI/bge-small-zh-v1.5/quantize_config.json",
    "models/BAAI/bge-small-zh-v1.5/special_tokens_map.json",
    "models/BAAI/bge-small-zh-v1.5/tokenizer.json",
    "models/BAAI/bge-small-zh-v1.5/tokenizer_config.json",
    "models/BAAI/bge-small-zh-v1.5/vocab.txt",
    "models/BAAI/bge-small-zh-v1.5/onnx/model_quantized.onnx"
  ];

  for (const relativePath of requiredFiles) {
    const details = await stat(join(packageDirectory, relativePath));
    assert(details.isFile() && details.size > 0, `packaged file is missing or empty: ${relativePath}`);
  }

  const model = await stat(join(packageDirectory, "models/BAAI/bge-small-zh-v1.5/onnx/model_quantized.onnx"));
  assert(model.size > 1_000_000, "packaged ONNX model appears to be a placeholder");

  const packagedManifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  assert(packagedManifest.bin?.docnexus === "dist/src/cli.js", "package bin does not expose dist/src/cli.js");
}

async function runJson(executable, args, cwd, env) {
  const result = await run(executable, args, { cwd, env });
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`command did not return JSON: ${executable} ${args.join(" ")}\n${result.stdout}`, { cause: error });
  }
}

async function run(executable, args, options) {
  try {
    return await execFileAsync(executable, args, { ...options, maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    throw new Error(`command failed: ${executable} ${args.join(" ")}\n${stdout}${stderr}`, { cause: error });
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

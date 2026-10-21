import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";
import { cleanupLegacyProject, installationProjectRoot } from "../src/legacy-cleanup.js";
import { initializeProject } from "../src/project.js";

const execute = promisify(execFile);
const roots: string[] = [];
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "docnexus-install-cleanup-"));
  roots.push(root);
  return root;
}
async function legacy(root: string, name = "docnexus", version = 6) {
  const directory = join(root, name);
  await mkdir(join(directory, "library"), { recursive: true });
  await writeFile(join(directory, "project.json"), JSON.stringify({ format_version: version, initialized_at: "2026-01-01T00:00:00Z" }));
  await writeFile(join(directory, "library", "old.md"), "Old knowledge");
  return directory;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("deletes old knowledge, history and npm runtime, removing only legacy agent integration", async () => {
  const root = await makeRoot();
  const directory = await legacy(root);
  await mkdir(join(directory, ".git"));
  await writeFile(join(directory, ".git", "history"), "Old committed history");
  await mkdir(join(directory, "node_modules"));
  await writeFile(join(root, "package.json"), '{"name":"host-app"}');
  await mkdir(join(root, ".docnexus", "node_modules"), { recursive: true });
  await writeFile(join(root, ".docnexus", "node_modules", "new-runtime"), "Keep installed version");
  await mkdir(join(root, ".agents", "skills"), { recursive: true });
  await symlink(directory + "/skills/docnexus", join(root, ".agents", "skills", "docnexus"), "dir");
  await mkdir(join(root, ".agents", "skills", "docnexus-recall"));
  await writeFile(join(root, ".agents", "skills", "docnexus-recall", "SKILL.md"), "User-owned real directory");
  await writeFile(join(root, "AGENTS.md"), "# Host rules\n\n<!-- docnexus:start -->\nOld memory instructions\n<!-- docnexus:end -->\n");
  expect(await cleanupLegacyProject(root)).toEqual(["docnexus"]);
  await expect(lstat(directory)).rejects.toThrow();
  await expect(lstat(join(root, ".agents", "skills", "docnexus"))).rejects.toThrow();
  expect(await readFile(join(root, ".agents", "skills", "docnexus-recall", "SKILL.md"), "utf8")).toBe("User-owned real directory");
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("# Host rules\n");
  expect(await readFile(join(root, "package.json"), "utf8")).toBe('{"name":"host-app"}');
  expect(await readFile(join(root, ".docnexus", "node_modules", "new-runtime"), "utf8")).toBe("Keep installed version");
});

it("clears old hidden data while preserving the new installation's manifests and node_modules", async () => {
  const root = await makeRoot();
  const directory = await legacy(root, ".docnexus", 3);
  await mkdir(join(directory, "node_modules"));
  const files = new Map([
    [join(directory, "package.json"), '{"dependencies":{"@rowansenne/docnexus":"0.23.0"}}'],
    [join(directory, "package-lock.json"), "Installation lock"],
    [join(directory, "node_modules", "new-runtime"), "Installed runtime"]
  ]);
  for (const [file, content] of files) await writeFile(file, content);
  expect(await cleanupLegacyProject(root)).toEqual([".docnexus"]);
  expect((await readdir(directory)).sort()).toEqual(["node_modules", "package-lock.json", "package.json"]);
  for (const [file, content] of files) expect(await readFile(file, "utf8")).toBe(content);
  await expect(initializeProject(root)).resolves.toMatchObject({ created: true });
});

it("removes an old uninitialized npm installation identified by its DocNexus dependency", async () => {
  const root = await makeRoot();
  await mkdir(join(root, "docnexus"));
  await writeFile(join(root, "docnexus", "package.json"), '{"devDependencies":{"@rowansenne/docnexus":"0.23.0"}}');
  expect(await cleanupLegacyProject(root)).toEqual(["docnexus"]);
  await expect(stat(join(root, "docnexus"))).rejects.toThrow();
});

it.each([undefined, "broken json", { format_version: 7, initialized_at: "current" }, { format_version: 8, initialized_at: "future" },
  { format_version: 6 }, { format_version: "6", initialized_at: "invalid" }])("preserves unrecognized or current directories with marker %j", async marker => {
  const root = await makeRoot();
  await mkdir(join(root, "docnexus"));
  await writeFile(join(root, "docnexus", "keep.md"), "Unrelated or current data");
  if (marker !== undefined) await writeFile(join(root, "docnexus", "project.json"), typeof marker === "string" ? marker : JSON.stringify(marker));
  expect(await cleanupLegacyProject(root)).toEqual([]);
  expect(await readFile(join(root, "docnexus", "keep.md"), "utf8")).toBe("Unrelated or current data");
});

it("preserves current format-7 data and agent context when a separate legacy directory is removed", async () => {
  const root = await makeRoot();
  await initializeProject(root, { outputDir: "workfull", agents: ["codex"] });
  const context = await readFile(join(root, "AGENTS.md"), "utf8");
  await writeFile(join(root, "workfull", "docnexus", "library", "keep.md"), "Current knowledge");
  await legacy(root);
  expect(await cleanupLegacyProject(root)).toEqual(["docnexus"]);
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(context);
  await expect(stat(join(root, ".agents", "skills", "docnexus", "SKILL.md"))).resolves.toBeDefined();
  expect(await readFile(join(root, "workfull", "docnexus", "library", "keep.md"), "utf8")).toBe("Current knowledge");
  expect(await cleanupLegacyProject(root)).toEqual([]);
});

it("does not follow legacy directory or marker symlinks", async () => {
  const root = await makeRoot();
  const external = await makeRoot();
  await legacy(external);
  await symlink(join(external, "docnexus"), join(root, "docnexus"), "dir");
  expect(await cleanupLegacyProject(root)).toEqual([]);
  await rm(join(root, "docnexus"));
  await mkdir(join(root, "docnexus"));
  await symlink(join(external, "docnexus", "project.json"), join(root, "docnexus", "project.json"), "file");
  expect(await cleanupLegacyProject(root)).toEqual([]);
  expect(await readFile(join(external, "docnexus", "library", "old.md"), "utf8")).toBe("Old knowledge");
});

it("refuses to follow a symlinked agent context before deleting legacy data", async () => {
  const root = await makeRoot();
  const external = await makeRoot();
  await legacy(root);
  await writeFile(join(external, "AGENTS.md"), "External rules\n<!-- docnexus:start -->old<!-- docnexus:end -->\n");
  const original = await readFile(join(external, "AGENTS.md"), "utf8");
  await symlink(join(external, "AGENTS.md"), join(root, "AGENTS.md"), "file");
  await expect(cleanupLegacyProject(root)).rejects.toThrow("symbolic links");
  expect(await readFile(join(external, "AGENTS.md"), "utf8")).toBe(original);
  await expect(stat(join(root, "docnexus", "project.json"))).resolves.toBeDefined();
});

it("derives the consuming root from the installed package path and refuses the old install prefix", () => {
  const root = resolve(tmpdir(), "docnexus-location");
  expect(installationProjectRoot(join(root, ".docnexus", "node_modules", "@rowansenne", "docnexus"))).toBe(root);
  expect(installationProjectRoot(join(root, "node_modules", "@rowansenne", "docnexus"))).toBe(root);
  expect(() => installationProjectRoot(join(root, "docnexus", "node_modules", "@rowansenne", "docnexus"))).toThrow("--prefix ./.docnexus");
  expect(installationProjectRoot(root)).toBeUndefined();
  expect(installationProjectRoot(join(root, "_npx", "temporary", "node_modules", "@rowansenne", "docnexus"))).toBeUndefined();
  expect(installationProjectRoot(join(root, "node_modules", "other", "node_modules", "@rowansenne", "docnexus"))).toBeUndefined();
});

it("runs destructive cleanup through the real npm installation hook and preserves current data on rebuild", async () => {
  const caller = await makeRoot();
  const root = await makeRoot();
  const fixture = join(caller, "package");
  await mkdir(join(fixture, "dist", "src"), { recursive: true });
  await mkdir(join(fixture, "scripts"));
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  await writeFile(join(fixture, "package.json"), JSON.stringify({ name: manifest.name, version: manifest.version, type: "module",
    files: ["dist/src", "scripts/postinstall.mjs"], scripts: { postinstall: manifest.scripts.postinstall } }));
  await cp(resolve("scripts/postinstall.mjs"), join(fixture, "scripts", "postinstall.mjs"));
  for (const name of ["legacy-cleanup", "skills", "agent-context", "layout", "errors", "workspace-io"]) {
    const code = ts.transpileModule(await readFile(resolve("src", `${name}.ts`), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }
    }).outputText;
    await writeFile(join(fixture, "dist", "src", `${name}.js`), code);
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const env = { ...process.env, npm_config_cache: join(caller, "cache"), npm_config_global: "false", npm_config_ignore_scripts: "false" };
  const packed = JSON.parse((await execute(npm, ["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", caller], { cwd: fixture, env })).stdout);
  await legacy(caller); // The caller's CWD is not the consuming project and must remain untouched.
  await legacy(root);
  await legacy(root, ".docnexus", 3);
  await writeFile(join(root, ".docnexus", "package.json"), '{"private":true}');
  const installation = join(root, ".docnexus");
  const installed = await execute(npm, ["install", "--prefix", installation, "--offline", "--no-audit", "--no-fund", "--package-lock=false", "--foreground-scripts", join(caller, packed[0].filename)], { cwd: caller, env });
  expect(installed.stdout + installed.stderr).toContain("removed legacy docnexus/");
  await expect(stat(join(root, "docnexus"))).rejects.toThrow();
  await expect(stat(join(root, ".docnexus", "project.json"))).rejects.toThrow();
  await expect(stat(join(installation, "node_modules", "@rowansenne", "docnexus", "scripts", "postinstall.mjs"))).resolves.toBeDefined();
  await expect(stat(join(caller, "docnexus", "library", "old.md"))).resolves.toBeDefined();
  await initializeProject(root);
  await writeFile(join(root, "docnexus", "library", "keep.md"), "Current data");
  await execute(npm, ["rebuild", "--prefix", installation, "--offline", "--foreground-scripts"], { cwd: caller, env });
  expect(await readFile(join(root, "docnexus", "library", "keep.md"), "utf8")).toBe("Current data");
}, 30_000);

it("skips source checkouts before build and global installs without loading project cleanup", async () => {
  const root = await makeRoot();
  await legacy(root);
  await mkdir(join(root, "scripts"));
  await cp(resolve("scripts/postinstall.mjs"), join(root, "scripts/postinstall.mjs"));
  await execute(process.execPath, [join(root, "scripts/postinstall.mjs")], { cwd: root });
  const globalPackage = join(root, "global", "node_modules", "@rowansenne", "docnexus");
  await mkdir(join(globalPackage, "scripts"), { recursive: true });
  await cp(resolve("scripts/postinstall.mjs"), join(globalPackage, "scripts/postinstall.mjs"));
  await execute(process.execPath, [join(globalPackage, "scripts/postinstall.mjs")], { cwd: root, env: { ...process.env, npm_config_global: "true" } });
  expect(await readFile(join(root, "docnexus/library/old.md"), "utf8")).toBe("Old knowledge");
});

it("preserves an unrelated application directory even when it depends on DocNexus", async () => {
  const root = await makeRoot();
  await mkdir(join(root, "docnexus", "src"), { recursive: true });
  await writeFile(join(root, "docnexus", "package.json"), '{"dependencies":{"@rowansenne/docnexus":"0.23.0"}}');
  await writeFile(join(root, "docnexus", "src", "app.js"), "Host application");
  expect(await cleanupLegacyProject(root)).toEqual([]);
  expect(await readFile(join(root, "docnexus", "src", "app.js"), "utf8")).toBe("Host application");
});

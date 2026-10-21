import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
const exec = promisify(execFile);
const adapter = resolve("skills/docnexus-library/scripts/query-documents.mjs");
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each([true, false])("resolves a workspace CLI when available (%s) and retains legacy root fallback", async nested => {
  const root = await mkdtemp(join(tmpdir(), "docnexus-query-adapter-")); roots.push(root);
  for (const [directory, installation] of [[root, "legacy"], ...(nested ? [[join(root, ".docnexus"), "workspace"]] : [])]) {
    const cliDirectory = join(directory, "node_modules/@rowansenne/docnexus/dist/src");
    await mkdir(cliDirectory, { recursive: true });
    await writeFile(join(cliDirectory, "cli.js"), `process.stdout.write(JSON.stringify({ installation: ${JSON.stringify(installation)}, args: process.argv.slice(2) }));`);
  }
  const output = JSON.parse((await exec(process.execPath, [adapter, "--project-root", root, "--all"], { cwd: tmpdir() })).stdout);
  expect(output).toEqual({ installation: nested ? "workspace" : "legacy", args: ["--project-root", root, "document", "query", "--all"] });
});

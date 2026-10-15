#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

// Thin orchestration adapter: the installed CLI owns validation, snapshots and rendering.
const args = process.argv.slice(2);
let root = process.cwd();
try {
  if (args[0] === "--project-root") {
    if (!args[1] || args[1].startsWith("--")) throw new Error("--project-root requires a value");
    root = resolve(args[1]);
    args.splice(0, 2);
  }
  const require = createRequire(join(root, "package.json"));
  const cli = require.resolve("@rowansenne/docnexus/dist/src/cli.js");
  const child = spawn(process.execPath, [cli, "--project-root", root, "document", "query", ...args], { stdio: "inherit" });
  child.on("error", (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

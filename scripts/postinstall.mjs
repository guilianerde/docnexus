import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// Source checkouts run npm ci before dist exists; global installs have no consuming project.
if (process.env.npm_config_global !== "true" && basename(dirname(dirname(packageRoot))) === "node_modules") {
  const { cleanupLegacyProject, installationProjectRoot } = await import("../dist/src/legacy-cleanup.js");
  const project = installationProjectRoot(packageRoot);
  if (project) {
    for (const directory of await cleanupLegacyProject(project)) {
      process.stderr.write(`docnexus: removed legacy ${directory}/ data during installation (no migration).\n`);
    }
  }
}

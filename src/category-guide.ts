import { join } from "node:path";
import { workspaceDirectory, workspacePath } from "./layout.js";
import { assertNoSymbolicLinks, atomicWrite, readIfExists } from "./workspace-io.js";

export const CATEGORY_GUIDE_FILE = "categories.md";

/**
 * Starter vocabulary for model-driven classification. It is deliberately plain
 * project material: the CLI never reads it, so edits cannot change validation,
 * query counts or stored metadata.
 */
export const CATEGORY_GUIDE = `# Suggested categories

DocNexus categories are project-defined names, not a fixed taxonomy. This file is an editable starter list for the agent that classifies documents; the CLI never reads it.

- Reuse an existing category that already fits the document; otherwise prefer a name below when its meaning fits, and reuse it exactly.
- Rename, delete or add entries as the project evolves. A category exists once a document uses it; changing this file does not reclassify existing documents (use \`document classify\`).
- An explicit category from the user or a calling skill always takes precedence.
- Keep one primary category per document and put sub-topics in \`tags\`. Names are flat: \`pitfalls/build\` is one category name, not a hierarchy, so queries must use the full string.

| Category | Use for |
| --- | --- |
| pitfalls | Recurring failures, rework, traps and how to avoid them |
| templates | Reusable file, document or code templates and filling instructions |
| api-contracts | API, CLI, data-format and compatibility contracts |
| deployment-ops | Releases, rollbacks, environment setup and operations |
| system-design | Module boundaries, data flow and key design tradeoffs |
| decisions | Important decisions, alternatives and rationale |
| guides | Step-by-step instructions for people executing a task |

These starter names are in English. Rename them if the project works in another language; they are never reserved.
`;

/** Creates the starter guide when absent; never overwrites project edits. */
export async function ensureCategoryGuide(projectRoot: string): Promise<void> {
  // Reject symlinked workspaces, files and dangling links before reading or creating.
  const relativePath = join(workspaceDirectory(projectRoot), CATEGORY_GUIDE_FILE);
  await assertNoSymbolicLinks(projectRoot, relativePath);
  const path = join(workspacePath(projectRoot), CATEGORY_GUIDE_FILE);
  if (await readIfExists(path) !== undefined) return;
  await atomicWrite(path, CATEGORY_GUIDE);
}
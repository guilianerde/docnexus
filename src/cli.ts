#!/usr/bin/env node
import { DocNexusError, asDocNexusError, errorEnvelope } from "./errors.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { runDoctor } from "./doctor.js";
import { ensureManagedWorkspace } from "./managed-documents.js";
import { requireInitializedProject } from "./project.js";
import { ensureSkillsCurrent } from "./skills.js";
import { withProjectLock } from "./project-lock.js";
import { startDocumentViewer } from "./viewer.js";
import { observeUsage } from "./usage.js";
import { resolveCommand } from "./cli-commands.js";
import { json } from "./cli-options.js";

export interface RunCliDependencies {
  doctor?: typeof runDoctor;
}

const defaultDependencies = {
  doctor: runDoctor
} satisfies Required<RunCliDependencies>;

export async function runCli(
  argv: string[],
  cwd = process.cwd(),
  dependencies: RunCliDependencies = defaultDependencies
): Promise<string> {
  try {
    const invocation = parseInvocation(argv, cwd);
    const [command, subcommand] = invocation.argv;
    // Hook callbacks must capture state without preflight writes or recovery;
    // their handlers own the project/index lock ordering.
    if (command === "git") return await runCliUnlocked(argv, cwd, dependencies);
    const computesEmbeddings = command === "recall"
      || (command === "index" && ["sync", "rebuild"].includes(subcommand))
      || (command === "graph" && subcommand === "repair");
    return await observeUsage(invocation.projectRoot, invocation.argv, () => computesEmbeddings
      ? runCliUnlocked(argv, cwd, dependencies)
      : withProjectLock(invocation.projectRoot, () => runCliUnlocked(argv, cwd, dependencies)));
  } catch (error) { throw asDocNexusError(error); }
}

async function runCliUnlocked(argv: string[], cwd: string, dependencies: RunCliDependencies): Promise<string> {
  const { doctor } = { ...defaultDependencies, ...dependencies };
  const invocation = parseInvocation(argv, cwd);
  const [command, subcommand, ...rest] = invocation.argv;
  const projectRoot = invocation.projectRoot;
  const resolved = resolveCommand(command, subcommand);

  if (resolved?.definition.workspace) {
    await preflightWorkspace(projectRoot, command === "skills" && subcommand === "sync");
  }
  if (!resolved?.handler) {
    throw new DocNexusError("unknown_command", `Unknown command. Usage:
${USAGE}`);
  }
  return resolved.handler({ projectRoot, subcommand, rest, args: invocation.argv.slice(1), doctor });
}

async function preflightWorkspace(projectRoot: string, syncingSkills: boolean): Promise<void> {
  await withProjectLock(projectRoot, async () => {
    await requireInitializedProject(projectRoot);
    // Workspace skills follow the installed package; reads use text records directly.
    if (syncingSkills) return;
    const synced = await ensureSkillsCurrent(projectRoot);
    if (synced) {
      await ensureManagedWorkspace(projectRoot);
      process.stderr.write(`docnexus: refreshed .docnexus/skills to ${synced.version}\n`);
    }
  });
}

const USAGE = `Setup
  docnexus init [--output-dir <directory>] [--agent claude|codex|all] [--git-remote <url>]
  docnexus --project-root path/to/project init [--git-remote <url>]
  docnexus skills sync
  docnexus skills link --target claude|codex|all
  docnexus doctor [--json]
  docnexus protocol
  docnexus status

Capture (extract -> seal -> ingest)
  docnexus draft new [--slug auth]
  docnexus metadata validate --file .docnexus/drafts/<draft_id>/metadata.json
  docnexus draft seal --id <draft_id> --file <library_path.md> [--base-version <record_version|new>] [--category <name> [--category-reason <basis>]]
  docnexus draft preview --id <draft_id>
  docnexus document add --draft <draft_id> [--replace]
  docnexus draft list [--status open|ready|ingested|invalid]
  docnexus draft discard --id <draft_id> --force

Related-page impact tracking
  docnexus impact save --file <project-relative-input.json>
  docnexus impact list [--status pending|done|dismissed|needs_review]
  docnexus impact get --id <impact_id>
  docnexus impact set --id <impact_id> --document <document_id> --status pending|done|dismissed --reason <basis> --revision <hash>

Find and read
  docnexus search "local memory" --limit 5 [--category <name>]
  docnexus recall "local memory" --limit 5 [--mode hybrid|vector] [--category <name>]
  docnexus recall "local memory" --return-unit window|section|page --context-budget 4000 [--category <name>]
  docnexus concepts [--type component] [--query auth] [--category <name>] [--format json|md]
  docnexus facts list [--entity name-or-alias] [--at ISO-timestamp] [--include-inactive]

Library
  docnexus document query [--all | --page 1 --page-size 20] [--category guide] [--revision <snapshot>]
  docnexus view [--port 0]   # Local read-only document browser; Ctrl+C to stop
  docnexus document list [--limit 50] [--tag tag]
  docnexus document get --id <document_id> [--include source,document,metadata,timeline,template]
  docnexus document render
  docnexus document classify --id <document_id> --category <project-category> --reason <basis> [--revision <snapshot>]
  docnexus document sync --id <document_id> [--metadata-file <path>]
  docnexus document sync --file <library_path.md> [--metadata-file <path>]
  docnexus document delete --file <library_path.md> --force
  docnexus document delete --id doc_0000000000000000 --force

Maintenance
  docnexus git hooks install|status|uninstall
  docnexus usage enable|disable|status
  docnexus usage export   # Redirect JSON to a file to share for analysis
  docnexus usage feedback --rating useful|partial|miss [--reason needs_multihop|missing_document|irrelevant|truncated|stale|slow|other] [--event <event_id>]
  docnexus index status
  docnexus index sync
  docnexus index rebuild --force
  docnexus graph audit
  docnexus graph repair --force
  docnexus embeddings install --from <model_dir> [--replace]
  docnexus reset --force`;

function parseInvocation(argv: string[], cwd: string): { argv: string[]; projectRoot: string; json: boolean } {
  const args = [...argv];
  let projectRoot = resolve(cwd), json = false;
  while (args[0] === "--json" || args[0] === "--project-root") {
    if (args.shift() === "--json") { json = true; continue; }
    const root = args.shift();
    if (!root || root.startsWith("--")) throw new DocNexusError("invalid_params", "--project-root requires a value");
    projectRoot = resolve(cwd, root);
  }
  const filtered = args.filter((arg, index) => {
    if (arg !== "--json" || (index === 1 && ["search", "recall"].includes(args[0]))) return true;
    json = true; return false;
  });
  return { argv: filtered, projectRoot, json };
}

export async function runMain(argv: string[], cwd = process.cwd()): Promise<void> {
  try {
    const invocation = parseInvocation(argv, cwd);
    if (invocation.argv[0] === "view") {
      const args = invocation.argv.slice(1);
      if (args.length !== 0 && (args.length !== 2 || args[0] !== "--port" || !/^\d+$/.test(args[1]))) {
        throw new DocNexusError("invalid_params", "Usage: docnexus view [--port 0]");
      }
      const viewer = await startDocumentViewer(invocation.projectRoot, args.length ? Number(args[1]) : 0);
      process.stdout.write(`DocNexus document viewer: ${viewer.url}\nProject: ${invocation.projectRoot}\nRead-only · Ctrl+C to stop\n`);
      const stop = () => { void viewer.close().catch(() => { process.exitCode = 1; }); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      return;
    }
    process.stdout.write(await runCli(argv, cwd));
  } catch (error) {
    let root = resolve(cwd), machine = argv.includes("--json");
    try { const invocation = parseInvocation(argv, cwd); root = invocation.projectRoot; machine = invocation.json; } catch {}
    if (!machine) throw asDocNexusError(error);
    const envelope = errorEnvelope(error, root);
    process.stdout.write(json(envelope));
    process.exitCode = 1;
  }
}

export function isDirectCliInvocation(
  moduleUrl: string,
  argv1: string | undefined,
  realpath: (path: string) => string = realpathSync.native ?? realpathSync
): boolean {
  if (!argv1) {
    return false;
  }
  try {
    const modulePath = realpath(fileURLToPath(moduleUrl));
    const argvPath = realpath(argv1);
    return modulePath === argvPath;
  } catch {
    return false;
  }
}

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  void runMain(process.argv.slice(2)).catch(error => {
    let root = process.cwd();
    try { root = parseInvocation(process.argv.slice(2), root).projectRoot; } catch {}
    const envelope = errorEnvelope(error, root);
    process.stderr.write(`${envelope.code}: ${envelope.message}\nNext: ${envelope.next_action.message}\n`);
    process.exitCode = 1;
  });
}

# DocNexus Global MCP With Explicit Project Selection

## Purpose

DocNexus currently binds an MCP process to one initialized project at startup through:

```bash
docnexus mcp --project-root /path/to/project
```

That model requires users to register one MCP entry per project. The new model provides one reusable MCP registration for the machine while preserving project-local storage isolation. Every MCP tool call must explicitly state which initialized project it operates on.

## Decisions

- MCP remains a stdio server started by the Agent client on demand. This change does not introduce a persistent daemon or network listener.
- Users register MCP once with `docnexus mcp`.
- The old startup binding mode, `docnexus mcp --project-root /path`, is removed rather than supported as a fallback.
- Every MCP tool accepts a required `project_root` field, including `validate_metadata`.
- MCP `project_root` values must be absolute paths.
- Every tool call validates that `project_root` identifies an initialized DocNexus project before performing its tool-specific operation.
- Storage remains project-local under `<project-root>/.docnexus/`; there is no shared global data store.
- Existing CLI data commands and the recall skill keep their current project resolution behavior. The capture skill preserves its existing workflow but must include the current project's absolute `project_root` when it invokes MCP tools.

## Architecture

### Server Lifetime

`docnexus mcp` starts a stateless MCP server. The process does not hold a mounted project and cannot implicitly route operations based on its startup directory or configuration arguments.

The same server process may receive operations for multiple initialized projects during one Agent session. Each operation is isolated by the explicit project path in that operation's arguments.

### Tool Contract

The MCP tools remain:

- `archive_record`
- `list_records`
- `get_record`
- `status`
- `validate_metadata`
- `upsert_file_index`
- `delete_file_index`
- `index_status`

Each tool schema adds:

```json
{
  "project_root": "/absolute/path/to/initialized/project"
}
```

alongside its existing arguments. `project_root` is routing context, not document metadata and not persisted as input content.

### Dispatch Boundary

The MCP server uses a shared dispatch boundary for every tool invocation:

1. Require `project_root` as a non-empty string.
2. Reject it unless it is an absolute path.
3. Run existing initialized-project validation on that path.
4. Pass the validated absolute project root and the remaining tool inputs into the existing archive/index/metadata operations.

This keeps project selection validation centralized while avoiding changes to storage and indexing modules that already receive a project root.

## Workflows

### One-Time MCP Registration

Codex and Claude configurations register a single command:

```bash
docnexus mcp
```

There is no per-project MCP registration and no startup project argument.

### Per-Project Initialization

Projects still establish independent DocNexus stores explicitly:

```bash
cd /path/to/project
docnexus init
```

Initialization and local `.docnexus/` storage semantics do not change.

### Tool Invocation

When an Agent uses an MCP tool, it includes the initialized target project's absolute path:

```json
{
  "project_root": "/path/to/project",
  "source": "conversation",
  "document": "...",
  "metadata": {}
}
```

The same MCP process can next call a tool against another initialized project by providing that other project's absolute path.

## Failure Behavior

- Missing `project_root`: reject the tool invocation as missing required project context.
- Relative `project_root`: reject it with a message stating that MCP tool calls require an absolute project path.
- Nonexistent or non-directory root: preserve the existing clear project path failure.
- Existing directory without `.docnexus/project.json`: reject it and direct the user to run `docnexus init` in that project.
- Unsupported project marker format: preserve the existing migration-required failure.
- Startup with `docnexus mcp --project-root /path`: reject it with usage for the global `docnexus mcp` form.

The service does not attempt to infer the project from the MCP process working directory, input file paths, or previous calls.

## Compatibility And Scope

This is an intentional MCP protocol break:

- MCP clients and prompt instructions must begin supplying `project_root` on every tool call.
- Old per-project MCP registrations must be replaced with the single global command.

Not included in this change:

- A global daemon or shared background process.
- An MCP `recall` tool.
- Changes to CLI `--project-root`, `docnexus init`, index/graph/recall commands, or skill workflow behavior beyond adapting MCP calls in the capture skill to the required `project_root` field.
- Changes to the local storage schema, LadybugDB graph data, or embedding behavior.

## Documentation Changes

Update the English and Chinese README files and product briefs to:

- show one MCP registration using `docnexus mcp`;
- explain that projects are still initialized independently;
- state that every MCP tool call carries an absolute `project_root`;
- remove directions to configure a separate MCP server per project; and
- remove the previous `docnexus mcp --project-root /path` invocation from public setup guidance.

Update the bundled `docnexus-capture` skill instructions so its metadata validation and archive calls pass the initialized current project's absolute `project_root`. The `docnexus-recall` skill remains CLI-based and requires no protocol change.

## Verification

Automated coverage will verify:

- MCP tool dispatch requires `project_root` and rejects relative paths.
- An uninitialized project cannot be used through an MCP tool.
- Every tool, including `validate_metadata`, routes through explicit initialized-project validation.
- One server can process calls against two initialized projects without data crossing between them.
- `docnexus mcp` starts without project binding and the former startup argument form is rejected.
- Existing CLI and skill-facing behaviors outside the MCP protocol remain passing.
- The bundled capture skill documents the required explicit MCP project argument without changing its content-refinement workflow.

Completion requires the full test suite, TypeScript typecheck, package build, and a documentation search confirming that user setup no longer instructs per-project MCP registration.

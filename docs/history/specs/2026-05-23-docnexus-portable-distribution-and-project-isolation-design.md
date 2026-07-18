# DocNexus Portable Distribution and Project Isolation Design

Date: 2026-05-23

## Context

DocNexus currently runs from a local source checkout. Its documentation configures MCP clients with an absolute path to `dist/src/index.js` and sets the managed project as the process working directory. The runtime then treats `process.cwd()` as `projectRoot`, while store operations create `.docnexus/` on demand.

This is workable during local development but is not a distributable user contract:

- users must know the author's source checkout/build layout
- the executable installation location and the managed project's data location are presented as the same concern
- an accidental working directory can create or read the wrong `.docnexus/` store
- there is no explicit initialization boundary indicating that a project has opted into DocNexus

DocNexus needs a portable package and an explicit per-project data boundary. It must continue to serve agents through MCP and skills without introducing a cross-project global memory database.

## Goal

Make DocNexus installable once and usable across multiple explicitly initialized projects.

This iteration should:

- prepare the package for distribution as `@docnexus/docnexus`
- expose daily commands through the short `docnexus` executable
- add manual per-project initialization through `docnexus init`
- isolate all persistent storage under each target project's `.docnexus/`
- bind each MCP stdio process to one initialized project through `--project-root`
- distribute DocNexus skills in the package and install them manually for Codex or Claude
- update English and Chinese documentation with portable install and configuration instructions

## Non-Goals

This iteration does not:

- introduce a long-running background daemon or shared base service process
- create a global database containing several projects
- allow MCP tools to select arbitrary project roots per call
- automatically edit Codex or Claude MCP configuration files
- change recall ranking, Graph RAG behavior, embeddings, or LadybugDB graph semantics
- publish the npm package or assert that the `@docnexus` npm scope is already owned
- rename existing index, graph, or recall business commands unless needed to route through the new CLI entrypoint

## Chosen Approach

Use a package-first, explicitly project-bound architecture.

The intended user model is:

1. Install the DocNexus executable once, preferably globally.
2. Enter a target project and explicitly initialize its `.docnexus/` data area.
3. Install Codex and/or Claude skills in that target project when wanted.
4. Manually register an MCP server entry bound to that initialized project.
5. Let the agent client start the stdio MCP process on demand.

The preferred installation flow is:

```bash
npm install -g @docnexus/docnexus

cd /path/to/your-project
docnexus init
docnexus skills install --target codex
docnexus skills install --target claude
```

For users who do not want a global install, a first invocation may use the scoped package directly:

```bash
npx -y @docnexus/docnexus init
```

After a local dependency installation, `npx docnexus ...` resolves the package binary. Without such an installation, documentation must not imply that `npx docnexus ...` resolves the scoped package.

## Architecture

### Runtime Package

The distributable package is named `@docnexus/docnexus` and exposes `docnexus` as its user-facing executable. The executable dispatches:

- existing index, graph, and recall CLI operations
- `init`
- `skills install`
- `mcp`

The package includes compiled runtime code and packaged skill source directories required by `skills install`. A GitHub clone/build path remains documented for contributors and pre-publication development, but it is not the primary end-user setup.

### Project Data Domain

Every managed project owns its data at:

```text
<project-root>/.docnexus/
```

This directory remains the home for all existing and future project-scoped artifacts, including:

- archived original content and extracted documents
- metadata and schemas
- SQLite status/index data where currently used
- LadybugDB vectors and graph relationships
- index events, audit status, and repair state

There is no global store joining project data. If a user initializes projects A and B, operations bound to A never open B's `.docnexus/` path.

### Initialization Boundary

`docnexus init` is the explicit opt-in boundary for project-local storage.

- With no root option, it initializes `process.cwd()`.
- With `--project-root <path>`, it initializes the specified directory.
- It creates the required `.docnexus/` layout and the marker file `.docnexus/project.json`.
- The marker contains `format_version: 1` and `initialized_at`; its presence and supported format version identify an initialized DocNexus project.
- It is idempotent and must not erase or rebuild existing archived records, embeddings, graph data, or event history.
- If a project already has a compatible `.docnexus/` data directory from the current local-development workflow, `init` adopts it by writing the marker after validation and preserves its existing data.

The current on-demand store creation behavior must be narrowed: commands that read or write managed data may not silently initialize an arbitrary working directory.

### Project Root Resolution

The CLI accepts a global root option:

```bash
docnexus --project-root /path/to/project <command>
```

For project-data commands other than MCP:

- no option means the current working directory is the target project
- an explicit option overrides the current working directory
- the resolved target must be initialized before the command proceeds

MCP is stricter:

```bash
docnexus mcp --project-root /path/to/project
```

The MCP subcommand requires its documented subcommand option form, `mcp --project-root <path>`. It must not infer its data domain from the MCP client's launch working directory. This distinction is intentional: ordinary CLI operations are project-local commands with a global override, while an MCP server registration must visibly bind its single data domain in the launch command.

## MCP Runtime Contract

DocNexus continues to use an MCP stdio server. It does not introduce a daemon.

Each configured MCP entry starts a DocNexus process as needed and binds that process to exactly one initialized project. The server constructs its tools with that fixed project root. Tools do not accept a `projectRoot` argument and cannot switch data domains during a conversation.

Conceptually:

```text
one installed executable
  -> zero or more client MCP configurations
     -> one on-demand stdio process per active configured project
        -> one project-local .docnexus/ store
```

Registering multiple projects does not duplicate the installed package or stored application code. Clients may run multiple Node processes when several bound MCP entries are active; this is an accepted cost of stronger per-project isolation in the first portable release.

### Client Configuration Shape

The documentation must show user-owned target paths rather than a DocNexus source checkout.

Codex example:

```bash
codex mcp add docnexus-my-project -- docnexus mcp --project-root /path/to/your-project
```

```toml
[mcp_servers.docnexus-my-project]
command = "docnexus"
args = ["mcp", "--project-root", "/path/to/your-project"]
```

Claude Code example:

```bash
claude mcp add --transport stdio docnexus-my-project -- docnexus mcp --project-root /path/to/your-project
```

```json
{
  "mcpServers": {
    "docnexus-my-project": {
      "command": "docnexus",
      "args": ["mcp", "--project-root", "/path/to/your-project"]
    }
  }
}
```

Documentation may also show `npx -y @docnexus/docnexus mcp ...` as a no-global-install alternative.

## Skills Distribution Contract

The npm package carries the existing DocNexus skills and exposes manual installation:

```bash
docnexus skills install --target codex
docnexus skills install --target claude
```

### Project Scope

Project scope is the default:

| Target | Destination |
| --- | --- |
| Codex | `<project-root>/.agents/skills/docnexus-*/SKILL.md` |
| Claude | `<project-root>/.claude/skills/docnexus-*/SKILL.md` |

Project-scoped installation resolves the project root using the same CLI rule as other local operations and requires that the project has already been initialized. This keeps skill availability aligned with the project's DocNexus data domain.

### User Scope

User-level installation is explicit:

```bash
docnexus skills install --target codex --scope user
docnexus skills install --target claude --scope user
```

User-scope installation only copies skill definitions into the supported user-level discovery directory. It does not create a project data store and does not weaken MCP project binding. A globally installed recall skill still requires the user to operate in a project with an initialized data domain and an appropriate bound MCP/CLI path.

## CLI Command Behavior

The new routing should preserve existing business command meanings:

```bash
docnexus index upsert path/to/file.md --name FileName --record-id rec_0000000000000000
docnexus index delete --file path/to/file.md
docnexus index delete --id file_0000000000000000
docnexus index rebuild --force
docnexus index status
docnexus graph audit
docnexus graph repair --force
docnexus recall "local memory" --limit 5
```

Those operations become subject to the explicit initialized-project requirement. This work does not add new capture behavior or adjust the current output protocols.

New administrative operations are:

```bash
docnexus init
docnexus skills install --target codex
docnexus skills install --target claude
docnexus mcp --project-root /path/to/project
```

## Error Handling

Failures must identify the violated boundary and the actionable repair.

| Condition | Required Behavior |
| --- | --- |
| `init` target directory does not exist or is not a directory | Fail without creating parent project directories; name the invalid path. |
| Repeated `init` on an initialized project | Succeed without destructive changes. |
| `init` finds a compatible pre-marker `.docnexus/` store | Preserve existing data and add `.docnexus/project.json`. |
| Marker format version is unsupported | Fail without writing data; state that migration is required. |
| Data command targets an uninitialized project | Fail and instruct the user to run `docnexus init` for that project. |
| MCP omits `--project-root` | Fail at startup with usage showing the required option. |
| MCP root is missing or uninitialized | Fail before serving tools; instruct the user to initialize that path. |
| Project-scope skills install targets an uninitialized project | Fail with the initialization instruction. |
| User-scope skills install is invoked outside an initialized project | Succeed if the target/scope arguments are valid. |
| Unknown skills target or scope | Fail with accepted values. |

Validation should happen at command/server startup rather than deferred until a tool has partially written project data.

## Data Flow

### Per-Project Setup

```text
user installs package once
  -> user runs docnexus init inside Project A
     -> Project A/.docnexus/ becomes a valid data domain
  -> user manually installs desired skills in Project A
  -> user manually registers MCP bound to Project A
```

### Agent MCP Invocation

```text
Codex or Claude starts configured stdio command
  -> docnexus mcp validates explicit Project A root
  -> server exposes existing tools closed over Project A root
  -> archive/index/status operations read/write only Project A/.docnexus/
```

### CLI Recall Invocation

```text
user runs docnexus recall in Project A, or with --project-root Project A
  -> CLI validates Project A was initialized
  -> retrieval opens Project A LadybugDB/index state
  -> grouped recall output remains unchanged by this distribution work
```

## Testing Strategy

Implementation must use focused tests before behavior changes and preserve existing retrieval/integration coverage.

### CLI and Initialization

- default root is the current working directory
- global `--project-root` overrides the working directory
- `init` creates a valid project data domain
- repeated `init` preserves a sentinel existing artifact or persisted record
- data commands fail before initializing an arbitrary directory

### Isolation

- initialize two temporary project roots
- store/index distinct content in each
- status and retrieval bound to project A never expose project B data
- project B remains independent after operations against A

### MCP

- `mcp` rejects a missing explicit project root
- `mcp` rejects a non-existent or uninitialized root
- server creation for an initialized root succeeds
- tools use only the bound root and do not expose a root-switching input

### Skills Installation

- project-scope Codex installation creates `.agents/skills/docnexus-*`
- project-scope Claude installation creates `.claude/skills/docnexus-*`
- project scope rejects an uninitialized project
- user scope installs independently of project initialization
- invalid target and scope fail clearly

### Package and Documentation

- package metadata exposes `docnexus` for the distributable package name
- packaged files include compiled entrypoints, skills, and user-facing documentation
- English and Chinese README examples use portable commands and contain no author-specific source path

## Documentation Deliverables

Update English and Chinese user documentation to cover:

- global installation as the recommended short-command flow
- scoped `npx -y @docnexus/docnexus ...` usage as an alternative
- GitHub source/build instructions for contributors and pre-publish development
- project initialization and storage isolation
- manual Codex and Claude skill installation
- manual MCP registration for Codex and Claude
- the distinction between an installed executable and an on-demand MCP stdio process

Update product/plan documentation where it currently implies a fixed local source path or implicit project store creation, so later work does not restore the obsolete runtime contract.

## Implementation Boundaries

The implementation plan should stay within the following boundaries:

- add only the initialization, project-root routing, MCP subcommand, skill installation, package metadata, tests, and documentation required for this distribution contract
- reuse existing store, CLI, MCP, and packaged skill structures where possible
- do not refactor retrieval or graph logic unless validation wiring requires a small direct change
- do not add configuration writers or client-specific installation automation in this iteration

## Success Criteria

The work is complete when:

- an installed `docnexus` executable can initialize and operate against a selected project
- no managed data command or MCP startup silently creates a new uninitialized project store
- two initialized projects remain isolated through CLI and MCP operations
- users can manually install packaged skills for Codex or Claude
- documentation gives portable setup instructions without a developer machine path
- all focused tests, existing tests, type checks, and build verification pass

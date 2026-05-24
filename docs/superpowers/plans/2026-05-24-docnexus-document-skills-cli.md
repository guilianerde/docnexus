# DocNexus Document Skills And CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move current-document create/update and delete workflows from MCP to manual agent skills backed by CLI commands, with confirmed overwrite enforcement.

**Architecture:** Keep the existing `upsertManagedDocument` and `deleteManagedDocument` service functions as the persistence boundary. Add a CLI adapter that reads prepared artifact files and requires `--replace` for registered-path updates; remove only the MCP mutation handlers; replace the combined capture skill with three single-purpose document workflow skills.

**Tech Stack:** TypeScript, Vitest, Node.js `fs/promises`, MCP SDK, Markdown skill definitions.

---

## File Map

- Modify `src/cli.ts`: expose `docnexus document add` and enforce the replacement flag before calling the existing document writer.
- Modify `src/mcp.ts`: remove `archive_record` and `delete_document` handler/registration surface.
- Modify `src/skills-install.ts`: install the new document workflow skills instead of `docnexus-capture`.
- Create `skills/docnexus-document-extract/SKILL.md`: non-persisting refinement workflow.
- Create `skills/docnexus-document-add/SKILL.md`: CLI-backed add/confirmed overwrite workflow.
- Create `skills/docnexus-document-delete/SKILL.md`: CLI-backed confirmed physical delete workflow.
- Delete `skills/docnexus-capture/SKILL.md`: eliminate the superseded combined workflow.
- Modify `test/cli.test.ts`: exercise add, replacement gating, delete, and use CLI/service setup rather than removed MCP writes.
- Modify `test/mcp.test.ts`: assert mutation tools are removed and set up read tests through service writes.
- Modify `test/skills-install.test.ts`: assert the new install set and workflow contents.
- Modify `README.md`, `README.zh-CN.md`, and `docs/product-brief-docnexus-mvp*.md`: publish the CLI/skills/MCP split.

### Task 1: Add CLI Document Create/Replace

**Files:**
- Modify: `test/cli.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write failing CLI tests for artifact-file add and overwrite enforcement**

Add a helper that writes source, refined Markdown, and metadata input files, then add tests shaped as:

```ts
const inputs = await writeDocumentInputs(projectRoot, {
  source: "Original source.",
  document: "# Current document\n\nFirst version.",
  metadata
});
const created = JSON.parse(await runCli([
  "document", "add",
  "--file", "docs/memory/auth.md",
  "--source-file", inputs.source,
  "--document-file", inputs.document,
  "--metadata-file", inputs.metadata
], projectRoot));
expect(created).toMatchObject({ file_path: "docs/memory/auth.md", operation: "created" });

await expect(runCli([
  "document", "add",
  "--file", "docs/memory/auth.md",
  "--source-file", inputs.source,
  "--document-file", inputs.document,
  "--metadata-file", inputs.metadata
], projectRoot)).rejects.toThrow("document add requires --replace");

const updated = JSON.parse(await runCli([
  "document", "add",
  "--file", "docs/memory/auth.md",
  "--source-file", inputs.source,
  "--document-file", inputs.document,
  "--metadata-file", inputs.metadata,
  "--replace"
], projectRoot));
expect(updated.operation).toBe("updated");
```

- [ ] **Step 2: Run the focused CLI tests to verify RED**

Run:

```bash
npm test -- test/cli.test.ts
```

Expected: failure because `document add` is not recognized.

- [ ] **Step 3: Implement the minimal CLI adapter**

In `src/cli.ts`, import `readFile`, `listManagedDocuments`, `upsertManagedDocument`, and `DocNexusMetadata`. Add a `document add` branch after project initialization:

```ts
if (command === "document" && subcommand === "add") {
  const replace = rest.includes("--replace");
  const options = parseOptions(rest.filter((arg) => arg !== "--replace"));
  if (!options.file || !options["source-file"] || !options["document-file"] || !options["metadata-file"]) {
    throw new Error("document add requires --file, --source-file, --document-file, and --metadata-file");
  }
  const existing = (await listManagedDocuments(projectRoot)).some((value) => value.file_path === options.file);
  if (existing && !replace) {
    throw new Error("document add requires --replace for an existing managed document");
  }
  return json(await upsertManagedDocument(projectRoot, {
    file_path: options.file,
    source: await readFile(options["source-file"], "utf8"),
    document: await readFile(options["document-file"], "utf8"),
    metadata: JSON.parse(await readFile(options["metadata-file"], "utf8")) as DocNexusMetadata
  }));
}
```

Add both add usage forms to the CLI usage text.

- [ ] **Step 4: Run the focused CLI tests to verify GREEN**

Run:

```bash
npm test -- test/cli.test.ts
```

Expected: PASS, including creation, rejected unconfirmed overwrite, confirmed replacement, existing delete, recall, and status behavior.

### Task 2: Remove MCP Mutation Tools

**Files:**
- Modify: `test/mcp.test.ts`
- Modify: `src/mcp.ts`

- [ ] **Step 1: Change MCP tests to require the removed surface**

Import `upsertManagedDocument` in `test/mcp.test.ts`. Replace setup calls to `callTool("archive_record", ...)` with service calls:

```ts
const archived = await upsertManagedDocument(projectRoot, {
  file_path: "docs/memory/mcp.md",
  source: "source",
  document: "document",
  metadata
});
```

Replace mutation behavior tests with:

```ts
it("does not expose document mutation tools", async () => {
  await expect(callTool("archive_record", {})).rejects.toThrow("Unknown tool: archive_record");
  await expect(callTool("delete_document", {})).rejects.toThrow("Unknown tool: delete_document");
});
```

- [ ] **Step 2: Run the MCP tests to verify RED**

Run:

```bash
npm test -- test/mcp.test.ts
```

Expected: failure because MCP still accepts `archive_record` and `delete_document`.

- [ ] **Step 3: Remove handlers and registrations**

In `src/mcp.ts`:

- Remove `deleteManagedDocument`, `upsertManagedDocument`, and `ArchiveRecordInput` imports.
- Remove `"archive_record"` and `"delete_document"` from `knownTools`.
- Remove both switch branches.
- Remove both `server.tool(...)` registrations.
- Remove `optionalString` when no longer used.

- [ ] **Step 4: Run MCP and CLI tests to verify GREEN**

Run:

```bash
npm test -- test/mcp.test.ts test/cli.test.ts
```

Expected: PASS; document mutation works only through CLI/service setup, and removed MCP names are rejected.

### Task 3: Replace Capture With Document Workflow Skills

**Files:**
- Modify: `test/skills-install.test.ts`
- Modify: `src/skills-install.ts`
- Create: `skills/docnexus-document-extract/SKILL.md`
- Create: `skills/docnexus-document-add/SKILL.md`
- Create: `skills/docnexus-document-delete/SKILL.md`
- Delete: `skills/docnexus-capture/SKILL.md`

- [ ] **Step 1: Write failing installation/content assertions**

Update packaged skill test fixture and expectations:

```ts
const names = [
  "docnexus-document-extract",
  "docnexus-document-add",
  "docnexus-document-delete",
  "docnexus-recall"
];

expect(add).toContain("docnexus document add");
expect(add).toContain("--replace");
expect(add).toContain("confirm");
expect(remove).toContain("docnexus document delete");
expect(extract).not.toContain("docnexus document add");
expect(result.installed).toEqual(names);
```

- [ ] **Step 2: Run skill tests to verify RED**

Run:

```bash
npm test -- test/skills-install.test.ts
```

Expected: failure because new skill files and installation list do not yet exist.

- [ ] **Step 3: Implement the new skill set**

Set the installation list in `src/skills-install.ts`:

```ts
const SKILL_NAMES = [
  "docnexus-document-extract",
  "docnexus-document-add",
  "docnexus-document-delete",
  "docnexus-recall"
] as const;
```

Write the new skill documents with these contracts:

```markdown
# DocNexus Document Extract

Prepare preserved source, refined Markdown, metadata, and a proposed `file_path`.
This workflow must not write, index, overwrite, or delete managed documents.
Use MCP `validate_metadata` only when validation is needed.
```

```markdown
# DocNexus Document Add

Run `docnexus document add --file ... --source-file ... --document-file ... --metadata-file ...`.
If the target is already managed, ask the user to confirm replacement first; after confirmation rerun with `--replace`.
```

```markdown
# DocNexus Document Delete

Explain that removal is physical and removes derived state. Ask for explicit confirmation, then run
`docnexus document delete --file ... --force` or `--id ... --force`.
```

Remove `skills/docnexus-capture/SKILL.md`.

- [ ] **Step 4: Run skill tests to verify GREEN**

Run:

```bash
npm test -- test/skills-install.test.ts
```

Expected: PASS; exactly four current workflow skills install.

### Task 4: Update User Documentation

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/product-brief-docnexus-mvp.md`
- Modify: `docs/product-brief-docnexus-mvp.en.md`
- Modify: `docs/product-brief-docnexus-mvp.zh-CN.md`

- [ ] **Step 1: Add a failing documentation regression test**

Extend `test/skills-install.test.ts` with README checks:

```ts
const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
const readmeZh = await readFile(join(process.cwd(), "README.zh-CN.md"), "utf8");
expect(readme).toContain("docnexus document add");
expect(readmeZh).toContain("docnexus document add");
expect(readme).not.toMatch(/\| `archive_record` \|/);
expect(readmeZh).not.toMatch(/\| `archive_record` \|/);
expect(readme).not.toMatch(/\| `delete_document` \|/);
expect(readmeZh).not.toMatch(/\| `delete_document` \|/);
```

- [ ] **Step 2: Run the focused docs assertion to verify RED**

Run:

```bash
npm test -- test/skills-install.test.ts
```

Expected: failure because README MCP tool tables still list the removed mutation tools.

- [ ] **Step 3: Rewrite lifecycle documentation to the new public contract**

For all five documentation files:

- Replace `docnexus-capture` with the three document workflow skills.
- Show `docnexus document add ...` and its confirmed-overwrite `--replace` form.
- Keep `docnexus document delete ... --force` as the physical deletion command.
- Remove MCP descriptions of `archive_record` and `delete_document`.
- State that MCP still provides read/status/metadata-validation access only for these document functions.

- [ ] **Step 4: Run the docs and skill tests to verify GREEN**

Run:

```bash
npm test -- test/skills-install.test.ts
```

Expected: PASS.

### Task 5: Full Verification And Delivery

**Files:**
- Verify all modified files from Tasks 1-4.

- [ ] **Step 1: Check obsolete runtime references**

Run:

```bash
rg -n "archive_record|delete_document|docnexus-capture" src skills README.md README.zh-CN.md docs/product-brief-docnexus-mvp*.md test
```

Expected: only intentional unknown-tool assertions or historical/schema test fixtures remain; no current public workflow exposes MCP mutation or the superseded skill.

- [ ] **Step 2: Run the full automated suite**

Run:

```bash
npm test
npm run build
```

Expected: both commands PASS.

- [ ] **Step 3: Review git scope**

Run:

```bash
git diff --stat
git status --short
```

Expected: only implementation, tests, skills, and documentation files for this design are modified.

- [ ] **Step 4: Commit implementation**

```bash
git add src/cli.ts src/mcp.ts src/skills-install.ts skills test README.md README.zh-CN.md docs/product-brief-docnexus-mvp.md docs/product-brief-docnexus-mvp.en.md docs/product-brief-docnexus-mvp.zh-CN.md docs/superpowers/plans/2026-05-24-docnexus-document-skills-cli.md
git commit -m "feat: move document mutations to skills and cli"
```


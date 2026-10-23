import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { errorEnvelope } from "../src/errors.js";
import { upsertManagedDocument } from "../src/managed-documents.js";

const roots: string[] = [];
const metadata = { title: "Path guard", summary: "Library path validation", tags: [], entities: [], relationships: [] };

async function setup(parent: string) {
  const root = await mkdtemp(join(tmpdir(), "docnexus-draft-paths-"));
  roots.push(root);
  await runCli(["init", "--output-dir", parent], root);
  const draft = JSON.parse(await runCli(["draft", "new"], root));
  for (const [name, content] of Object.entries({ source: "Path decision", document: "# Path guard", metadata: JSON.stringify(metadata) })) {
    await writeFile(join(root, draft.artifacts[name]), content);
  }
  return { root, draft, library: `${parent === "." ? "" : `${parent}/`}docnexus/library` };
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each([".", "workflow-run", "docs/知识库"])("rejects project-relative seal paths under output parent %j and offers a working retry", async parent => {
  const { root, draft, library } = await setup(parent);
  const file = "dev/contract-template-version.md";
  const supplied = `./${library}/${file}`;
  const options = ["--base-version", "new", "--category", "开发", "--category-reason", "Caller chose this category"];
  const failure = await runCli(["draft", "seal", "--id", draft.draft_id, "--file", supplied, ...options], root).catch(error => error);
  const envelope = errorEnvelope(failure, root);
  expect(envelope).toMatchObject({ code: "invalid_params", message: expect.stringContaining("library-relative"),
    details: { supplied_file_path: supplied, suggested_file_path: file, library_root: library },
    next_action: { argv: ["docnexus", "--project-root", root, "draft", "seal", "--id", draft.draft_id, "--file", file, ...options] } });
  await expect(access(join(root, draft.draft_directory, "manifest.json"))).rejects.toThrow();
  await expect(access(join(root, library, library, file))).rejects.toThrow();
  expect(JSON.parse(await readFile(join(root, draft.artifacts.metadata), "utf8"))).toEqual(metadata);
  expect(JSON.parse(await runCli(["draft", "list"], root)).drafts).toEqual([{ draft_id: draft.draft_id, status: "open" }]);
  const sealed = JSON.parse(await runCli(envelope.next_action.argv!.slice(1), root));
  expect(sealed).toMatchObject({ file_path: file, library_path: `${library}/${file}`, category: "开发" });
  const preview = JSON.parse(await runCli(["draft", "preview", "--id", draft.draft_id], root));
  expect(preview).toMatchObject({ file_path: file, library_path: sealed.library_path, sealed_version: sealed.sealed_version });
});

it("preserves update versions and leaves an already sealed draft unchanged on a rejected reseal", async () => {
  const { root, draft, library } = await setup(".");
  const saved = await upsertManagedDocument(root, { file_path: "dev/a.md", source: "Old", document: "# Old", metadata });
  const current = JSON.parse(await runCli(["document", "get", "--id", saved.id], root));
  const args = ["draft", "seal", "--id", draft.draft_id, "--file", "dev/a.md", "--base-version", current.record_version];
  const sealed = JSON.parse(await runCli(args, root));
  const before = await readFile(join(root, sealed.manifest_file), "utf8");
  args[5] = `${library}/dev/a.md`;
  const failure = await runCli(args, root).catch(error => error);
  expect(errorEnvelope(failure, root).next_action.argv).toEqual([
    "docnexus", "--project-root", root, "draft", "seal", "--id", draft.draft_id, "--file", "dev/a.md", "--base-version", current.record_version
  ]);
  expect(await readFile(join(root, sealed.manifest_file), "utf8")).toBe(before);
});

it.each(["dev/library/a.md", "examples/docnexus/library/a.md", "docnexus/library-notes/a.md"])("allows legitimate nested library-relative path %j", async file => {
  const { root, draft } = await setup(".");
  const sealed = JSON.parse(await runCli(["draft", "seal", "--id", draft.draft_id, "--file", file], root));
  expect(sealed).toMatchObject({ file_path: file, library_path: `docnexus/library/${file}` });
});

it("keeps existing records with duplicated library prefixes readable", async () => {
  const { root, library } = await setup("workflow-run");
  const file = `${library}/dev/legacy.md`;
  const saved = await upsertManagedDocument(root, { file_path: file, source: "Old", document: "# Legacy", metadata });
  expect(JSON.parse(await runCli(["document", "list"], root)).records).toEqual([expect.objectContaining({ id: saved.id, file_path: file })]);
  expect(JSON.parse(await runCli(["document", "get", "--id", saved.id, "--include", "document"], root)))
    .toMatchObject({ id: saved.id, file_path: file, document: "# Legacy" });
});

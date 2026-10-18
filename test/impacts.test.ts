import { cp, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { deleteManagedDocument, getManagedRecord, upsertManagedDocument } from "../src/managed-documents.js";
import { getImpact, listImpacts, saveImpact, setImpactStatus, type ImpactInput } from "../src/impacts.js";

const roots: string[] = [];
const metadata = { title: "Auth", summary: "Auth", tags: [], entities: [], relationships: [] };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "docnexus-impacts-")); roots.push(root); await runCli(["init"], root);
  const source = await upsertManagedDocument(root, { file_path: "auth.md", source: "New policy", document: "# Auth\n\n24-hour lifetime.", metadata });
  const guide = await upsertManagedDocument(root, { file_path: "guide.md", source: "Prior guide", document: "# Guide\n\nRefresh every six days.", metadata });
  const history = await upsertManagedDocument(root, { file_path: "review.md", source: "Commit A review", document: "# Historical review\n\nSeven days at commit A.", metadata });
  const input: ImpactInput = { source: { id: source.id, record_version: (await getManagedRecord(root, source.id)).record_version },
    scope: "Token lifetime", limitations: "Only discovered subject pages",
    pages: [
      { id: guide.id, file_path: "guide.md", record_version: (await getManagedRecord(root, guide.id)).record_version, decision: "update", evidence: "Six days exceeds the new lifetime", proposed_action: "Review and revise refresh steps" },
      { id: history.id, file_path: "review.md", record_version: (await getManagedRecord(root, history.id)).record_version, decision: "no_change", evidence: "Describes commit A", proposed_action: "Preserve the historical report" }
    ] };
  return { root, source, guide, history, input };
}
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("supports existing workspaces, saves one text record and preserves knowledge when changing status", async () => {
  const { root, guide, input } = await setup();
  expect(await listImpacts(root)).toEqual({ impacts: [] });
  const before = await getManagedRecord(root, guide.id);
  const saved = await saveImpact(root, input);
  expect(saved.pages.map(page => page.status)).toEqual(["pending", "done"]);
  // The save acknowledgement is a summary; evidence, proposed actions and history come from impact get.
  expect(saved.pages[0]).toEqual({ id: guide.id, file_path: "guide.md", decision: "update", status: "pending", needs_review: false });
  expect(saved).not.toHaveProperty("scope");
  expect(saved.details).toEqual(["impact", "get", "--id", saved.id]);
  expect((await getImpact(root, saved.id)).pages[0]).toMatchObject({ evidence: input.pages[0].evidence, history: [expect.objectContaining({ status: "pending" })] });
  expect((await getImpact(root, saved.id)).revision).toBe(saved.revision);
  expect(JSON.parse(await readFile(join(root, saved.impact_path), "utf8")).input).toEqual(input);
  const pending = await listImpacts(root, "pending");
  expect(pending.impacts[0].pages.map(page => page.id)).toEqual([guide.id]);
  const changed = await setImpactStatus(root, { id: saved.id, document: guide.id, status: "done", reason: "Reviewed the separate guide update", revision: saved.revision });
  expect(changed.pages[0].history).toHaveLength(2);
  expect(changed.pages[0].recorded_status).toBe("done");
  expect(await getManagedRecord(root, guide.id)).toEqual(before);
  expect((await saveImpact(root, input)).result).toBe("impact_exists");
  expect((await getImpact(root, saved.id)).pages[0].history).toHaveLength(2);
  expect((await setImpactStatus(root, { id: saved.id, document: guide.id, status: "done", reason: "Reviewed the separate guide update", revision: changed.revision })).result).toBe("impact_unchanged");
  await expect(stat(join(root, "docnexus/store/brain.pglite"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("reopens changed context for review and rejects stale acknowledgments, including other writers", async () => {
  const { root, source, guide, input } = await setup();
  const saved = await saveImpact(root, input);
  await upsertManagedDocument(root, { file_path: "guide.md", source: "Confirmed revision", document: "# Guide\n\nRefresh before expiry.", metadata });
  await expect(setImpactStatus(root, { id: saved.id, document: guide.id, status: "done", reason: "Old context", revision: saved.revision })).rejects.toMatchObject({ code: "impact_changed" });
  const fresh = await getImpact(root, saved.id);
  expect(fresh.pages[0]).toMatchObject({ status: "needs_review", recorded_status: "pending" });
  expect((await listImpacts(root, "needs_review")).impacts[0].pages).toHaveLength(1);
  const checked = await setImpactStatus(root, { id: saved.id, document: guide.id, status: "done", reason: "Reread the revised guide", revision: fresh.revision });
  expect(checked.pages[0]).toMatchObject({ status: "done", needs_review: false, record_version: input.pages[0].record_version });
  await expect(setImpactStatus(root, { id: saved.id, document: guide.id, status: "pending", reason: "Competing writer", revision: fresh.revision })).rejects.toMatchObject({ code: "impact_changed" });
  await upsertManagedDocument(root, { file_path: "auth.md", source: "Policy changed again", document: "# Auth\n\n12-hour lifetime.", metadata });
  expect((await getImpact(root, saved.id)).pages.every(page => page.status === "needs_review")).toBe(true);
  expect((await saveImpact(root, input)).result).toBe("impact_exists");
  expect((await getManagedRecord(root, source.id)).document).toContain("12-hour");
});

it("detects fact-time drift even when a related record version has not changed", async () => {
  const { root, guide, input } = await setup();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
  await upsertManagedDocument(root, { file_path: "guide.md", source: "Temporary rule", document: "# Guide\n\n{{fact:fact_temporary}}\n", metadata: { ...metadata, facts: [{ id: "fact_temporary", text: "Temporary policy", provenance: "Confirmed rule", valid_from: "2020-01-01T00:00:00Z", valid_until: "2026-10-18T00:00:00Z" }] } });
  input.pages[0].record_version = (await getManagedRecord(root, guide.id)).record_version;
  const saved = await saveImpact(root, input);
  vi.setSystemTime(new Date("2026-10-19T00:00:00Z"));
  const fresh = await getImpact(root, saved.id);
  expect(fresh.pages[0]).toMatchObject({ status: "needs_review", current_record_version: input.pages[0].record_version });
  expect(fresh.revision).not.toBe(saved.revision);
});

it("keeps deleted and recreated pages distinct and permits reasoned dismissal", async () => {
  const { root, guide, input } = await setup(); const saved = await saveImpact(root, input);
  await deleteManagedDocument(root, { id: guide.id, confirm: true });
  const replacement = await upsertManagedDocument(root, { file_path: "guide.md", source: "Different page", document: "# New guide", metadata });
  expect(replacement.id).not.toBe(guide.id);
  const fresh = await getImpact(root, saved.id);
  expect(fresh.pages[0]).toMatchObject({ status: "needs_review", current_record_version: null });
  await expect(setImpactStatus(root, { id: saved.id, document: guide.id, status: "done", reason: "Missing page", revision: fresh.revision })).rejects.toMatchObject({ code: "invalid_params" });
  const dismissed = await setImpactStatus(root, { id: saved.id, document: guide.id, status: "dismissed", reason: "The original page was retired; replacement has a different identity", revision: fresh.revision });
  expect(dismissed.pages[0].status).toBe("dismissed");
  expect((await listImpacts(root, "dismissed")).impacts[0].pages[0].id).toBe(guide.id);
});

it("rejects stale capture versions, malformed decisions and forged paths before saving", async () => {
  const { root, input } = await setup();
  const stale = structuredClone(input); stale.source.record_version = "0".repeat(64);
  await expect(saveImpact(root, stale)).rejects.toMatchObject({ code: "target_changed" });
  const changed = structuredClone(input); changed.pages[0].record_version = "0".repeat(64);
  await expect(saveImpact(root, changed)).rejects.toMatchObject({ code: "target_changed" });
  const duplicate = structuredClone(input); duplicate.pages.push(duplicate.pages[0]);
  await expect(saveImpact(root, duplicate)).rejects.toMatchObject({ code: "invalid_params" });
  const wrong = structuredClone(input); wrong.pages[0].file_path = "other.md";
  await expect(saveImpact(root, wrong)).rejects.toMatchObject({ code: "invalid_params" });
  const unread = structuredClone(input); unread.pages[0].record_version = null;
  await expect(saveImpact(root, unread)).rejects.toMatchObject({ code: "invalid_params" });
  unread.pages[0].decision = "unverified";
  const unverified = await saveImpact(root, unread);
  expect(unverified.pages[0]).toMatchObject({ decision: "unverified", status: "pending" });
  expect((await getImpact(root, unverified.id)).pages[0]).toMatchObject({ record_version: null });
});

it("works from a copied text workspace through the CLI and reset removes impact records", async () => {
  const { root, input, guide } = await setup();
  const inputFile = join(root, "impact-input.json"); await writeFile(inputFile, JSON.stringify(input));
  const saved = JSON.parse(await runCli(["impact", "save", "--file", inputFile], root));
  const clone = await mkdtemp(join(tmpdir(), "docnexus-impact-clone-")); roots.push(clone);
  await cp(join(root, "docnexus"), join(clone, "docnexus"), { recursive: true });
  const loaded = JSON.parse(await runCli(["impact", "get", "--id", saved.id], clone));
  expect(loaded.revision).toBe(saved.revision);
  const updated = JSON.parse(await runCli(["impact", "set", "--id", saved.id, "--document", guide.id, "--status", "pending", "--reason", "Resume in another workspace", "--revision", loaded.revision], clone));
  expect(updated.pages[0].history).toHaveLength(2);
  expect((await getImpact(root, saved.id)).pages[0].history).toHaveLength(1);
  await runCli(["reset", "--force"], clone); await runCli(["init"], clone);
  expect(JSON.parse(await runCli(["impact", "list"], clone))).toEqual({ impacts: [] });
});

it("resumes a failed impact registration from its attachment without re-ingesting the primary", async () => {
  const { root, source, input } = await setup();
  const current = await getManagedRecord(root, source.id);
  const draft = JSON.parse(await runCli(["draft", "new"], root));
  for (const [name, content] of Object.entries({ source: "Confirmed policy supplement: retain logout audit events.",
    document: `${current.document}\n\nRetain logout audit events.`, metadata: JSON.stringify(current.metadata) })) {
    await writeFile(join(root, draft.artifacts[name]), content);
  }
  const attachment = join(root, draft.draft_directory, "impact.json");
  await writeFile(attachment, JSON.stringify(input));
  await runCli(["draft", "seal", "--id", draft.draft_id, "--file", "auth.md", "--base-version", current.record_version], root);
  await runCli(["draft", "preview", "--id", draft.draft_id], root);
  await runCli(["document", "add", "--draft", draft.draft_id, "--replace"], root);
  const receiptPath = join(root, draft.draft_directory, "manifest.json");
  const receipt = await readFile(receiptPath, "utf8");
  const saved = await getManagedRecord(root, source.id);
  await expect(runCli(["impact", "save", "--file", attachment], root)).rejects.toMatchObject({ code: "target_changed" });
  expect(JSON.parse(await readFile(receiptPath, "utf8")).status).toBe("ingested");
  expect(await listImpacts(root)).toEqual({ impacts: [] });
  const retained = JSON.parse(await readFile(attachment, "utf8"));
  retained.source.record_version = saved.record_version;
  await writeFile(attachment, JSON.stringify(retained));
  expect(JSON.parse(await runCli(["impact", "save", "--file", attachment], root)).result).toBe("impact_saved");
  expect(await readFile(receiptPath, "utf8")).toBe(receipt);
  expect(await getManagedRecord(root, source.id)).toEqual(saved);
});

it("rejects malformed storage, path traversal, symlinks and incomplete CLI options", async () => {
  const { root, input } = await setup();
  await expect(runCli(["impact", "save"], root)).rejects.toMatchObject({ code: "invalid_params" });
  await expect(runCli(["impact", "list", "--status", "other"], root)).rejects.toMatchObject({ code: "invalid_params" });
  await expect(runCli(["impact", "get", "--id", "../../outside"], root)).rejects.toMatchObject({ code: "invalid_params" });
  const saved = await saveImpact(root, input);
  await writeFile(join(root, saved.impact_path), "{}");
  await expect(getImpact(root, saved.id)).rejects.toMatchObject({ code: "text_integrity_error" });
  await expect(listImpacts(root)).rejects.toMatchObject({ code: "text_integrity_error" });
  await rm(join(root, "docnexus/impacts"), { recursive: true });
  const outside = await mkdtemp(join(tmpdir(), "docnexus-impact-outside-")); roots.push(outside);
  await symlink(outside, join(root, "docnexus/impacts"), "dir");
  await expect(saveImpact(root, input)).rejects.toThrow("symbolic links");
  await expect(listImpacts(root)).rejects.toThrow("symbolic links");
  await expect(stat(join(outside, `${saved.id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
});

it("records impact counts and pseudonyms without exporting review evidence, paths or reasons", async () => {
  const { root, input, guide } = await setup();
  input.pages[0].evidence = "PRIVATE_IMPACT_EVIDENCE";
  const file = join(root, "impact-input.json"); await writeFile(file, JSON.stringify(input));
  await runCli(["usage", "enable"], root);
  const saved = JSON.parse(await runCli(["impact", "save", "--file", file], root));
  await runCli(["impact", "list"], root);
  await runCli(["impact", "set", "--id", saved.id, "--document", guide.id, "--status", "pending", "--reason", "PRIVATE_REVIEW_REASON", "--revision", saved.revision], root);
  const text = await runCli(["usage", "export"], root), exported = JSON.parse(text);
  expect(exported.events.map((event: { action: string }) => event.action)).toEqual(["save", "list", "set"]);
  expect(exported.events[0]).toMatchObject({ command: "impact", impact_pages: 2, impact_needs_review: 0 });
  expect(exported.events[0].impact_id).toMatch(/^[a-f0-9]{64}$/);
  for (const value of [root, file, saved.id, guide.id, input.pages[0].file_path, input.scope, "PRIVATE_IMPACT_EVIDENCE", "PRIVATE_REVIEW_REASON", saved.revision]) expect(text).not.toContain(value);
});

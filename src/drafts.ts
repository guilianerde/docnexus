import { DocNexusError, rereadCommand } from "./errors.js";
import { withProjectLock } from "./project-lock.js";
import { mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { sha256, stableJson } from "./hash.js";
import { draftsPath, INTERNAL_DIRNAME } from "./layout.js";
import { listRecordFiles, normalizeManagedFilePath, readAssets } from "./workspace-reader.js";
import { assertNoSymbolicLinks } from "./workspace-io.js";
import { validateMetadata } from "./metadata.js";
import { assertRefinedDocumentLength } from "./document-length.js";
import { isDocumentCategory, type DocNexusMetadata } from "./types.js";
import { atomicWrite } from "./workspace-io.js";
import { factDocumentTemplate, factReferenceIds, renderFactDocument } from "./fact-renderer.js";
import { validateKnowledgeWrite } from "./knowledge-service.js";

export const DRAFT_MANIFEST_SCHEMA_VERSION = 3;

const ARTIFACTS = {
  source: "source.md",
  document: "document.md",
  metadata: "metadata.json"
} as const;

type ArtifactName = keyof typeof ARTIFACTS;

export type DraftStatus = "open" | "ready" | "ingested" | "invalid";

export interface DraftManifest {
  schema_version: number;
  status: "ready" | "ingested";
  draft_id: string;
  sealed_at: string;
  file_path: string;
  artifacts: Record<ArtifactName, string>;
  hashes: Record<ArtifactName, string>;
  base_record_hash: string | null;
  document_id?: string;
  ingested_at?: string;
  rendered_hash?: string;
}

export interface NewDraftOutput {
  draft_id: string;
  draft_directory: string;
  artifacts: Record<ArtifactName, string>;
}

export interface SealDraftOutput {
  result: "draft_ready";
  draft_id: string;
  manifest_file: string;
  file_path: string;
  artifacts: Record<ArtifactName, string>;
  metadata_validation: "passed";
  replaces_managed_document: boolean;
  sealed_version: string;
  category?: string;
  category_reason?: string;
  preview_file?: string;
}

export interface DraftSummary {
  draft_id: string;
  status: DraftStatus;
  file_path?: string;
  document_id?: string;
  error?: string;
}

export interface SealedDraft {
  manifest: DraftManifest;
  source: string;
  document: string;
  metadata: DocNexusMetadata;
}

const DRAFT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SLUG_PATTERN = /[^A-Za-z0-9-]+/g;

function assertDraftId(draftId: string | undefined): string {
  if (!draftId || !DRAFT_ID_PATTERN.test(draftId) || draftId.includes("..")) {
    throw new DocNexusError("draft_invalid", "draft id must contain only letters, digits, '.', '_' or '-'");
  }
  return draftId;
}

function relativeDraftPath(draftId: string, file?: string): string {
  const base = `${INTERNAL_DIRNAME}/drafts/${draftId}`;
  return file ? `${base}/${file}` : base;
}

function artifactPaths(draftId: string): Record<ArtifactName, string> {
  return {
    source: relativeDraftPath(draftId, ARTIFACTS.source),
    document: relativeDraftPath(draftId, ARTIFACTS.document),
    metadata: relativeDraftPath(draftId, ARTIFACTS.metadata)
  };
}

async function draftDirectory(projectRoot: string, draftId: string): Promise<string> {
  const root = await realpath(projectRoot);
  await assertNoSymbolicLinks(root, join(INTERNAL_DIRNAME, "drafts", draftId));
  return join(draftsPath(root), draftId);
}

async function readArtifact(directory: string, name: ArtifactName): Promise<string> {
  const content = await readFile(join(directory, ARTIFACTS[name]), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new DocNexusError("draft_invalid", `draft artifact is missing: ${ARTIFACTS[name]}`);
    }
    throw error;
  });
  if (content.trim().length === 0) {
    throw new DocNexusError("draft_invalid", `draft artifact is empty: ${ARTIFACTS[name]}`);
  }
  return content;
}

async function readManifest(directory: string): Promise<DraftManifest | undefined> {
  const content = await readFile(join(directory, "manifest.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  return content === undefined ? undefined : (JSON.parse(content) as DraftManifest);
}

async function writeManifest(directory: string, manifest: DraftManifest): Promise<void> {
  await atomicWrite(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function timestampId(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Creates a fresh, uniquely named draft directory and returns where each artifact must be written. */
export async function createDraft(projectRoot: string, input: { slug?: string } = {}): Promise<NewDraftOutput> {
  return withProjectLock(projectRoot, async () => {
    const slug = (input.slug ?? "").replace(SLUG_PATTERN, "-").replace(/^-+|-+$/g, "").slice(0, 48).toLowerCase();
    const base = `draft_${timestampId(new Date())}${slug ? `_${slug}` : ""}`;
    await mkdir(draftsPath(projectRoot), { recursive: true });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const draftId = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const directory = await draftDirectory(projectRoot, draftId);
      try {
        await mkdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          continue;
        }
        throw error;
      }
      return { draft_id: draftId, draft_directory: relativeDraftPath(draftId), artifacts: artifactPaths(draftId) };
    }
    throw new DocNexusError("draft_invalid", "could not allocate a unique draft id");
  });
}

/** Verifies the three artifacts of a draft and writes its manifest, making it ready for ingestion. */
export async function sealDraft(
  projectRoot: string,
  input: { draftId: string; filePath: string; baseRecordHash?: string | null; category?: string; categoryReason?: string }
): Promise<SealDraftOutput> {
  return withProjectLock(projectRoot, async () => {
    if (input.category !== undefined && !isDocumentCategory(input.category)) {
      throw new DocNexusError("invalid_params", "category must be a trimmed name of 1–80 characters without control characters");
    }
    if (input.categoryReason !== undefined && (input.category === undefined || typeof input.categoryReason !== "string" || !input.categoryReason.trim() || input.categoryReason.length > 2000)) {
      throw new DocNexusError("invalid_params", "category reason must be non-empty, at most 2000 characters, and requires --category");
    }
    const draftId = assertDraftId(input.draftId);
    const directory = await draftDirectory(projectRoot, draftId);
    const existing = await readManifest(directory).catch(() => undefined);
    if (existing?.status === "ingested") {
      throw new DocNexusError("draft_invalid", `draft ${draftId} was already ingested; create a new draft for further changes`);
    }
    const filePath = await normalizeManagedFilePath(projectRoot, input.filePath);
    const source = await readArtifact(directory, "source");
    const document = await readArtifact(directory, "document");
    let metadataText = await readArtifact(directory, "metadata");
    let metadata: unknown;
    try {
      metadata = JSON.parse(metadataText);
    } catch (error) {
      throw new DocNexusError("draft_invalid", `draft metadata.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (input.category !== undefined && metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
      metadata = { ...metadata, category: input.category, category_reason: input.categoryReason ?? "Explicit category supplied by caller." };
      metadataText = `${JSON.stringify(metadata, null, 2)}\n`;
    }
    const validation = validateMetadata(metadata);
    if (!validation.valid) {
      throw new DocNexusError("draft_invalid", `draft metadata is invalid: ${validation.errors.join("; ")}`);
    }

    const prior = (await listRecordFiles(projectRoot)).find((value) => value.file_path === filePath);
    if (input.baseRecordHash !== undefined && input.baseRecordHash !== null && !/^[a-f0-9]{64}$/.test(input.baseRecordHash)) {
      throw new DocNexusError("invalid_params", "base version must be a SHA-256 record_version or new");
    }
    if (prior && input.baseRecordHash === undefined) {
      throw new DocNexusError("invalid_params", "updating an existing document requires --base-version <record_version> from the extraction read; reread and merge before sealing");
    }
    const baseRecordHash = input.baseRecordHash ?? null;
    if (baseRecordHash !== (prior ? sha256(stableJson(prior)) : null)) {
      throw new DocNexusError("target_changed", "draft target changed since reading; reread the current document, merge changes, then seal and review again",
        undefined, prior ? { command: rereadCommand(prior.id) } : undefined);
    }
    const manifest: DraftManifest = {
      schema_version: DRAFT_MANIFEST_SCHEMA_VERSION,
      status: "ready",
      draft_id: draftId,
      sealed_at: new Date().toISOString(),
      file_path: filePath,
      artifacts: artifactPaths(draftId),
      hashes: { source: sha256(source), document: sha256(document), metadata: sha256(metadataText) },
      base_record_hash: baseRecordHash
    };
    let previewFile: string | undefined;
    // Check the whole fact chain at seal time, so every issue is reported before review and ingestion.
    const prospective = await validateKnowledgeWrite(projectRoot, { id: prior?.id ?? "draft_preview", file_path: filePath, metadata: metadata as DocNexusMetadata, document });
    const rendered = renderFactDocument(document, prospective.knowledge.facts).document;
    assertRefinedDocumentLength(rendered, filePath);
    if (factReferenceIds(document).length) {
      manifest.rendered_hash = sha256(rendered);
      previewFile = relativeDraftPath(draftId, "preview.md");
      await atomicWrite(join(directory, "preview.md"), rendered);
    }
    // Classification is part of the reviewed artifact hash, never a late ingest override.
    if (input.category !== undefined) await atomicWrite(join(directory, ARTIFACTS.metadata), metadataText);
    await writeManifest(directory, manifest);
    return {
      result: "draft_ready",
      draft_id: draftId,
      manifest_file: relativeDraftPath(draftId, "manifest.json"),
      file_path: filePath,
      artifacts: manifest.artifacts,
      metadata_validation: "passed",
      replaces_managed_document: prior !== undefined,
      sealed_version: sha256(stableJson(manifest)),
      ...(input.category !== undefined ? { category: input.category, category_reason: input.categoryReason ?? "Explicit category supplied by caller." } : {}),
      ...(previewFile ? { preview_file: previewFile } : {})
    };
  });
}

/** Deliver the current sealed document without recording a review or changing the draft. */
export async function previewDraft(projectRoot: string, draftId: string) {
  return withProjectLock(projectRoot, async () => {
    const draft = await loadSealedDraft(projectRoot, draftId);
    const template = factDocumentTemplate(draft.document);
    const prior = (await listRecordFiles(projectRoot)).find(record => record.file_path === draft.manifest.file_path);
    if (prior) await readAssets(projectRoot, prior);
    const prospective = await validateKnowledgeWrite(projectRoot, {
      id: prior?.id ?? "draft_preview", file_path: draft.manifest.file_path, metadata: draft.metadata, document: template
    });
    const document = renderFactDocument(template, prospective.knowledge.facts).document;
    assertRefinedDocumentLength(document, draft.manifest.file_path);
    if (factReferenceIds(template).length && draft.manifest.rendered_hash === undefined) {
      throw new DocNexusError("preview_changed", "fact-backed draft requires a sealed preview; seal the draft again");
    }
    if (draft.manifest.rendered_hash !== undefined && draft.manifest.rendered_hash !== sha256(document)) {
      throw new DocNexusError("preview_changed", "referenced facts changed after preview; seal the draft again and review its new preview");
    }
    return { result: "draft_preview" as const, draft_id: draft.manifest.draft_id, file_path: draft.manifest.file_path,
      sealed_version: sha256(stableJson(draft.manifest)), document_hash: sha256(document), document };
  });
}

/** Loads a sealed draft and verifies its artifacts are unchanged since sealing. */
export async function loadSealedDraft(projectRoot: string, draftIdInput: string): Promise<SealedDraft> {
  return withProjectLock(projectRoot, async () => {
    const draftId = assertDraftId(draftIdInput);
    const directory = await draftDirectory(projectRoot, draftId);
    const manifest = await readManifest(directory);
    if (!manifest) {
      throw new DocNexusError("draft_invalid", `draft ${draftId} is not sealed; run "docnexus draft seal" first`);
    }
    if (manifest.status !== "ready") {
      throw new DocNexusError("draft_invalid", `draft ${draftId} is ${manifest.status}; only ready drafts can be ingested`);
    }
    if (manifest.draft_id !== draftId || manifest.schema_version !== DRAFT_MANIFEST_SCHEMA_VERSION) {
      throw new DocNexusError("draft_invalid", `draft ${draftId} has an invalid manifest; seal it again`);
    }
    if (manifest.base_record_hash !== null && (typeof manifest.base_record_hash !== "string" || !/^[a-f0-9]{64}$/.test(manifest.base_record_hash))) {
      throw new DocNexusError("draft_invalid", `draft ${draftId} has no valid target version; seal it again`);
    }
    const prior = (await listRecordFiles(projectRoot)).find((value) => value.file_path === manifest.file_path);
    if (manifest.base_record_hash !== (prior ? sha256(stableJson(prior)) : null)) {
      throw new DocNexusError("target_changed", `draft ${draftId} target changed since sealing; reread the current document, merge changes, then seal and review again`,
        undefined, prior ? { command: rereadCommand(prior.id) } : undefined);
    }
    const source = await readArtifact(directory, "source");
    const document = await readArtifact(directory, "document");
    const metadataText = await readArtifact(directory, "metadata");
    const actual = { source: sha256(source), document: sha256(document), metadata: sha256(metadataText) };
    const changed = (Object.keys(actual) as ArtifactName[]).filter((name) => manifest.hashes?.[name] !== actual[name]);
    if (changed.length > 0) {
      throw new DocNexusError("draft_changed", `draft ${draftId} changed after sealing (${changed.join(", ")}); seal it again`);
    }
    if (manifest.rendered_hash !== undefined) {
      await assertNoSymbolicLinks(await realpath(projectRoot), join(relativeDraftPath(draftId), "preview.md"));
      const preview = await readFile(join(directory, "preview.md"), "utf8");
      if (sha256(preview) !== manifest.rendered_hash) throw new DocNexusError("draft_changed", `draft ${draftId} preview changed after sealing; seal it again`);
    }
    return { manifest, source, document, metadata: JSON.parse(metadataText) as DocNexusMetadata };
  });
}

export async function markDraftIngested(projectRoot: string, draftId: string, documentId: string): Promise<void> {
  return withProjectLock(projectRoot, async () => {
    const file = await ingestionManifestFile(projectRoot, draftId, documentId);
    await atomicWrite(file.path, file.content);
  });
}

export async function ingestionManifestFile(projectRoot: string, draftId: string, documentId: string): Promise<{ path: string; content: string }> {
  const directory = await draftDirectory(projectRoot, assertDraftId(draftId));
  const manifest = await readManifest(directory);
  if (!manifest) {
    throw new DocNexusError("draft_invalid", `draft ${draftId} is not sealed`);
  }
  const ingested: DraftManifest = {
    ...manifest,
    status: "ingested",
    document_id: documentId,
    ingested_at: new Date().toISOString()
  };
  return { path: join(directory, "manifest.json"), content: `${JSON.stringify(ingested, null, 2)}\n` };
}

export async function listDrafts(projectRoot: string, input: { status?: DraftStatus } = {}): Promise<{ drafts: DraftSummary[] }> {
  return withProjectLock(projectRoot, async () => {
    const entries = await readdir(draftsPath(projectRoot), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    const drafts: DraftSummary[] = [];
    for (const entry of entries.filter((value) => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      try {
        const manifest = await readManifest(join(draftsPath(projectRoot), entry.name));
        drafts.push(
          manifest
            ? { draft_id: entry.name, status: manifest.status, file_path: manifest.file_path, document_id: manifest.document_id }
            : { draft_id: entry.name, status: "open" }
        );
      } catch (error) {
        drafts.push({ draft_id: entry.name, status: "invalid", error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { drafts: input.status ? drafts.filter((draft) => draft.status === input.status) : drafts };
  });
}

export async function discardDraft(
  projectRoot: string,
  input: { draftId: string; force: boolean }
): Promise<{ draft_id: string; discarded: true }> {
  return withProjectLock(projectRoot, async () => {
    if (!input.force) {
      throw new DocNexusError("draft_invalid", "draft discard requires --force");
    }
    const draftId = assertDraftId(input.draftId);
    const directory = await draftDirectory(projectRoot, draftId);
    const exists = await readdir(directory).then(() => true).catch(() => false);
    if (!exists) {
      throw new DocNexusError("draft_invalid", `draft not found: ${draftId}`);
    }
    await rm(directory, { recursive: true, force: true });
    return { draft_id: draftId, discarded: true };
  });
}

import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "./hash.js";
import { draftsPath, WORKSPACE_DIRNAME } from "./layout.js";
import { assertNoSymbolicLinks, isManagedFilePath, normalizeManagedFilePath } from "./managed-documents.js";
import { validateMetadata } from "./metadata.js";
import type { DocNexusMetadata } from "./types.js";

export const DRAFT_MANIFEST_SCHEMA_VERSION = 1;

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
  document_id?: string;
  ingested_at?: string;
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
    throw new Error("draft id must contain only letters, digits, '.', '_' or '-'");
  }
  return draftId;
}

function relativeDraftPath(draftId: string, file?: string): string {
  const base = `${WORKSPACE_DIRNAME}/drafts/${draftId}`;
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
  await assertNoSymbolicLinks(root, join(WORKSPACE_DIRNAME, "drafts", draftId));
  return join(draftsPath(root), draftId);
}

async function readArtifact(directory: string, name: ArtifactName): Promise<string> {
  const content = await readFile(join(directory, ARTIFACTS[name]), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error(`draft artifact is missing: ${ARTIFACTS[name]}`);
    }
    throw error;
  });
  if (content.trim().length === 0) {
    throw new Error(`draft artifact is empty: ${ARTIFACTS[name]}`);
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
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function timestampId(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Creates a fresh, uniquely named draft directory and returns where each artifact must be written. */
export async function createDraft(projectRoot: string, input: { slug?: string } = {}): Promise<NewDraftOutput> {
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
  throw new Error("could not allocate a unique draft id");
}

/** Verifies the three artifacts of a draft and writes its manifest, making it ready for ingestion. */
export async function sealDraft(
  projectRoot: string,
  input: { draftId: string; filePath: string }
): Promise<SealDraftOutput> {
  const draftId = assertDraftId(input.draftId);
  const directory = await draftDirectory(projectRoot, draftId);
  const existing = await readManifest(directory).catch(() => undefined);
  if (existing?.status === "ingested") {
    throw new Error(`draft ${draftId} was already ingested; create a new draft for further changes`);
  }
  const filePath = await normalizeManagedFilePath(projectRoot, input.filePath);
  const source = await readArtifact(directory, "source");
  const document = await readArtifact(directory, "document");
  const metadataText = await readArtifact(directory, "metadata");
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataText);
  } catch (error) {
    throw new Error(`draft metadata.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const validation = validateMetadata(metadata);
  if (!validation.valid) {
    throw new Error(`draft metadata is invalid: ${validation.errors.join("; ")}`);
  }

  const manifest: DraftManifest = {
    schema_version: DRAFT_MANIFEST_SCHEMA_VERSION,
    status: "ready",
    draft_id: draftId,
    sealed_at: new Date().toISOString(),
    file_path: filePath,
    artifacts: artifactPaths(draftId),
    hashes: { source: sha256(source), document: sha256(document), metadata: sha256(metadataText) }
  };
  await writeManifest(directory, manifest);
  return {
    result: "draft_ready",
    draft_id: draftId,
    manifest_file: relativeDraftPath(draftId, "manifest.json"),
    file_path: filePath,
    artifacts: manifest.artifacts,
    metadata_validation: "passed",
    replaces_managed_document: await isManagedFilePath(projectRoot, filePath)
  };
}

/** Loads a sealed draft and verifies its artifacts are unchanged since sealing. */
export async function loadSealedDraft(projectRoot: string, draftIdInput: string): Promise<SealedDraft> {
  const draftId = assertDraftId(draftIdInput);
  const directory = await draftDirectory(projectRoot, draftId);
  const manifest = await readManifest(directory);
  if (!manifest) {
    throw new Error(`draft ${draftId} is not sealed; run "docnexus draft seal" first`);
  }
  if (manifest.status !== "ready") {
    throw new Error(`draft ${draftId} is ${manifest.status}; only ready drafts can be ingested`);
  }
  if (manifest.draft_id !== draftId || manifest.schema_version !== DRAFT_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`draft ${draftId} has an invalid manifest; seal it again`);
  }
  const source = await readArtifact(directory, "source");
  const document = await readArtifact(directory, "document");
  const metadataText = await readArtifact(directory, "metadata");
  const actual = { source: sha256(source), document: sha256(document), metadata: sha256(metadataText) };
  const changed = (Object.keys(actual) as ArtifactName[]).filter((name) => manifest.hashes?.[name] !== actual[name]);
  if (changed.length > 0) {
    throw new Error(`draft ${draftId} changed after sealing (${changed.join(", ")}); seal it again`);
  }
  return { manifest, source, document, metadata: JSON.parse(metadataText) as DocNexusMetadata };
}

export async function markDraftIngested(projectRoot: string, draftId: string, documentId: string): Promise<void> {
  const directory = await draftDirectory(projectRoot, assertDraftId(draftId));
  const manifest = await readManifest(directory);
  if (!manifest) {
    throw new Error(`draft ${draftId} is not sealed`);
  }
  await writeManifest(directory, {
    ...manifest,
    status: "ingested",
    document_id: documentId,
    ingested_at: new Date().toISOString()
  });
}

export async function listDrafts(projectRoot: string, input: { status?: DraftStatus } = {}): Promise<{ drafts: DraftSummary[] }> {
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
}

export async function discardDraft(
  projectRoot: string,
  input: { draftId: string; force: boolean }
): Promise<{ draft_id: string; discarded: true }> {
  if (!input.force) {
    throw new Error("draft discard requires --force");
  }
  const draftId = assertDraftId(input.draftId);
  const directory = await draftDirectory(projectRoot, draftId);
  const exists = await readdir(directory).then(() => true).catch(() => false);
  if (!exists) {
    throw new Error(`draft not found: ${draftId}`);
  }
  await rm(directory, { recursive: true, force: true });
  return { draft_id: draftId, discarded: true };
}

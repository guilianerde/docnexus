export const PROTOCOL_VERSION = 1;

// One registry for thrown errors, CLI output, doctor findings and protocol discovery.
export const errorDefinitions = {
  invalid_params: { retryable: false, kind: "review", message: "Correct the named argument and retry." },
  unknown_command: { retryable: false, kind: "review", message: "Use a supported command from the usage output." },
  project_not_found: { retryable: false, kind: "configure", message: "Choose an existing project directory." },
  project_not_initialized: { retryable: false, kind: "configure", message: "Initialize the selected project before storing or recalling knowledge.", command: ["init"] },
  unsupported_format: { retryable: false, kind: "review", message: "Back up and inspect the workspace before choosing a migration or reset." },
  project_busy: { retryable: true, kind: "retry", message: "Wait for the current operation, then retry the same request." },
  git_unavailable: { retryable: false, kind: "configure", message: "Install Git to configure or use a Git-managed workspace; the default mode does not require Git." },
  git_operation_failed: { retryable: false, kind: "review", message: "Inspect the workspace repository and host tracking before retrying; Git setup may be partially complete." },
  git_branch_mismatch: { retryable: false, kind: "review", message: "Return to the pinned knowledge branch and review extra local branches before using DocNexus; do not discard changes automatically." },
  concurrent_update: { retryable: true, kind: "retry", message: "Updates kept changing the snapshot; retry after they settle." },
  target_changed: { retryable: false, kind: "review", message: "Reread the current document, metadata and timeline; merge before resealing with that read's record_version.", command: ["document", "query", "--all"] },
  document_revision_changed: { retryable: false, kind: "read", message: "Discard old pages and restart the document query from page 1.", command: ["document", "query", "--page", "1"] },
  document_not_found: { retryable: false, kind: "read", message: "List documents and choose a current identity.", command: ["document", "list"] },
  impact_not_found: { retryable: false, kind: "read", message: "List saved impact records and choose an existing identity.", command: ["impact", "list"] },
  impact_changed: { retryable: false, kind: "read", message: "Reread the impact and affected source/documents, then reconsider the status change.", command: ["impact", "list"] },
  draft_invalid: { retryable: false, kind: "review", message: "Inspect the draft and current target; repair, merge and review before sealing again.", command: ["draft", "list"] },
  draft_changed: { retryable: false, kind: "review", message: "Review the changed draft and current target before resealing." },
  preview_changed: { retryable: false, kind: "review", message: "Read the current referenced facts, reseal, and review the new preview." },
  text_integrity_error: { retryable: false, kind: "review", message: "Inspect canonical text with doctor; review edits before adopting them or restore damaged files from backup.", command: ["doctor"] },
  knowledge_conflict: { retryable: false, kind: "review", message: "Inspect entity and fact history; resolve the conflict without discarding valid facts." },
  invalid_metadata: { retryable: false, kind: "review", message: "Correct the reported metadata fields before sealing or writing." },
  index_outdated: { retryable: false, kind: "repair", message: "Synchronize verified text into the derived index.", command: ["index", "sync"] },
  index_schema_incompatible: { retryable: false, kind: "configure", message: "Use a DocNexus release compatible with this projection version; canonical text remains readable." },
  index_unavailable: { retryable: false, kind: "configure", message: "Check database configuration and availability; use text search while retrieval is unavailable." },
  embedding_failed: { retryable: false, kind: "configure", message: "Check the offline model with doctor; use text search while embedding is unavailable.", command: ["doctor"] },
  embedding_input_too_long: { retryable: false, kind: "review", message: "Shorten the query or split the input before embedding." },
  confirmation_required: { retryable: false, kind: "review", message: "Review the requested change and its authorization before using the required write flag." },
  skills_outdated: { retryable: false, kind: "repair", message: "Restore the packaged project skills.", command: ["skills", "sync"] },
  node_unsupported: { retryable: false, kind: "configure", message: "Use a supported Node.js version." },
  internal_error: { retryable: false, kind: "report", message: "Inspect doctor output and report the failure; do not assume the write succeeded.", command: ["doctor"] }
} as const;

export type ErrorCode = keyof typeof errorDefinitions;

export class DocNexusError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details?: Record<string, unknown>, options?: ErrorOptions) {
    super(message, options);
    this.name = "DocNexusError";
  }
}

export function asDocNexusError(error: unknown, fallback: ErrorCode = "internal_error"): DocNexusError {
  return error instanceof DocNexusError ? error : new DocNexusError(fallback, error instanceof Error ? error.message : String(error), undefined, { cause: error });
}

export function errorEnvelope(error: unknown, projectRoot: string) {
  const failure = asDocNexusError(error);
  const definition = errorDefinitions[failure.code];
  const argv = (command: readonly string[]) => ["docnexus", "--project-root", projectRoot, ...command];
  return {
    protocol_version: PROTOCOL_VERSION,
    status: "error" as const,
    code: failure.code,
    message: failure.message,
    retryable: definition.retryable,
    ...(definition.retryable ? { retry_after_ms: 1000 } : {}),
    next_action: { kind: definition.kind, message: definition.message,
      ...("command" in definition ? { argv: argv(definition.command) } : {}) },
    verify: { argv: argv(["doctor"]) },
    ...(failure.details ? { details: failure.details } : {})
  };
}

export type ErrorEnvelope = ReturnType<typeof errorEnvelope>;

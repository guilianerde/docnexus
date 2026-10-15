import type { Embedder } from "./embedder.js";
import { DocNexusError } from "./errors.js";
import { assembleEvidence, validateEvidenceOptions, type EvidenceOptions } from "./evidence.js";
import { withProjectLock } from "./project-lock.js";
import { recall, type RecallInput } from "./recall.js";
import { loadWorkspaceSnapshot } from "./workspace-snapshot.js";

/** Revalidate before assembling canonical evidence; embedding never runs under this read lock. */
export async function recallEvidence(root: string, input: RecallInput & EvidenceOptions, embedder?: Embedder) {
  validateEvidenceOptions(input);
  for (let attempt = 0; attempt < 3; attempt++) {
    const recalled = await recall(root, input, embedder);
    const packet = await withProjectLock(root, async () => {
      const snapshot = await loadWorkspaceSnapshot(root);
      if (snapshot.revision !== recalled.snapshot_revision) return undefined;
      return assembleEvidence(snapshot, recalled.query, recalled, input);
    });
    if (packet) return packet;
  }
  throw new DocNexusError("concurrent_update", "memory changed repeatedly before evidence delivery; retry after current updates complete");
}

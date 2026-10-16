import { AsyncLocalStorage } from "node:async_hooks";

export interface UsageMetrics {
  snapshot_loads?: number;
  document_count?: number;
  project_lock_wait_ms?: number;
  embedding_calls?: number;
  embedding_ms?: number;
  database_opens?: number;
  database_open_ms?: number;
  database_close_ms?: number;
  sync_attempts?: number;
  sync_processed_documents?: number;
  sync_embedded_chunks?: number;
  sync_reused_chunks?: number;
  sync_removed_documents?: number;
  recall_result_count?: number;
  graph_paths?: number;
  graph_supporting_chunks?: number;
  keyword_candidates?: number;
  vector_candidates?: number;
  keyword_top1_retained?: number;
  keyword_top3_retained?: number;
  relationship_declarations?: number;
}

export const usageMetrics = new AsyncLocalStorage<UsageMetrics>();

export function addUsageMetric(key: keyof UsageMetrics, value = 1): void {
  const metrics = usageMetrics.getStore();
  if (metrics) metrics[key] = (metrics[key] ?? 0) + value;
}

export function setUsageMetric(key: keyof UsageMetrics, value: number): void {
  const metrics = usageMetrics.getStore();
  if (metrics) metrics[key] = value;
}

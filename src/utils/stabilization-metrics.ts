/**
 * Lightweight in-memory metrics for production stabilization monitoring.
 * Used by the stabilization checklist to log timeout counts, queue duration, and DB pool config.
 * Grep-friendly log lines: [StabilizationChecklist], [StabilizationMetrics]
 */

const state = {
  fetchTimeoutCount: 0,
  lastSyncTokenHoldersDurationMs: null as number | null,
  lastSyncTokenHoldersCompletedAt: null as number | null,
};

export function incrementFetchTimeout(): void {
  state.fetchTimeoutCount += 1;
}

export function recordSyncTokenHoldersDuration(ms: number): void {
  state.lastSyncTokenHoldersDurationMs = ms;
  state.lastSyncTokenHoldersCompletedAt = Date.now();
}

export function getStabilizationSnapshot() {
  return {
    fetchTimeoutCount: state.fetchTimeoutCount,
    lastSyncTokenHoldersDurationMs: state.lastSyncTokenHoldersDurationMs,
    lastSyncTokenHoldersCompletedAt: state.lastSyncTokenHoldersCompletedAt,
  };
}

/** Reset counters (e.g. after logging checklist); keeps last duration for context. */
export function resetStabilizationCounters(): void {
  state.fetchTimeoutCount = 0;
}

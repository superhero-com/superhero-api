/**
 * Lightweight in-memory metrics for the token-gated-rooms relay pipeline
 * (Task 15, plan §13). Mirrors the canonical repo pattern in
 * `utils/stabilization-metrics.ts`: a module-level `state` object with
 * `incrementX`/`recordX`/`setX` setters + a `getTgrMetricsSnapshot()` reader +
 * a `resetTgrCounters()` that zeroes ONLY the rate counters.
 *
 * These are **process-local** (worker memory): the relay writer/subscriber +
 * publish processors run in the worker, so `publishOk`/`publishFailed`/
 * `ackTimeouts`/`relayReconnects` and the connection flags reflect THAT process.
 * When the JSON endpoint is served from the main process these fields read as
 * their main-process values (no relay socket there → `relayWriterConnected`
 * stays false, counters 0). The cron log line emitted by the WORKER carries the
 * authoritative values; the controller documents the main-served caveat.
 *
 * Grep-friendly log tags live in `tgr-metrics.constants.ts`: `[TgrMetrics]`,
 * `[TgrAlert]`.
 */

interface TgrMetricsState {
  // ── rate counters (reset each cron tick) ─────────────────────────────────
  /** Relay publishes the writer ACKed ok since the last reset. */
  publishOk: number;
  /** Relay publishes that failed (reject/timeout) since the last reset. */
  publishFailed: number;
  /** Publish ACK timeouts since the last reset (subset of `publishFailed`). */
  ackTimeouts: number;
  /** Relay writer reconnect attempts since the last reset. */
  relayReconnects: number;

  // ── connection flags / timestamps (NOT reset — point-in-time gauges) ──────
  /** Relay WRITE client connected + AUTHed (Task 07 `isHealthy()`). */
  relayWriterConnected: boolean;
  /** Relay READ/subscriber client connected (Task 14; false until it lands). */
  relaySubscriberConnected: boolean;
  /** Epoch ms of the most recent relay-writer disconnect (null = never). */
  lastRelayDisconnectAt: number | null;
  /** Epoch ms of the most recent relay-writer (re)connect (null = never). */
  lastRelayConnectAt: number | null;
}

const state: TgrMetricsState = {
  publishOk: 0,
  publishFailed: 0,
  ackTimeouts: 0,
  relayReconnects: 0,
  relayWriterConnected: false,
  relaySubscriberConnected: false,
  lastRelayDisconnectAt: null,
  lastRelayConnectAt: null,
};

// ── rate-counter setters ────────────────────────────────────────────────────

/** A relay publish was ACKed ok (call from the relay writer / publish path). */
export function incrementPublishOk(): void {
  state.publishOk += 1;
}

/** A relay publish failed (reject or timeout). `timedOut` also bumps the ACK-timeout counter. */
export function incrementPublishFailed(timedOut = false): void {
  state.publishFailed += 1;
  if (timedOut) {
    state.ackTimeouts += 1;
  }
}

/** A publish ACK did not arrive within `publishAckTimeoutMs`. */
export function incrementAckTimeout(): void {
  state.ackTimeouts += 1;
}

/** The relay writer attempted a reconnect. */
export function incrementRelayReconnect(): void {
  state.relayReconnects += 1;
}

// ── connection-flag setters ─────────────────────────────────────────────────

/**
 * Set the relay WRITE-client connection flag. A false→true edge stamps
 * `lastRelayConnectAt`; a true→false edge stamps `lastRelayDisconnectAt`, so the
 * `relay_down` debounce (Req 4.4) can measure how long the writer has been down.
 */
export function setRelayWriterConnected(connected: boolean): void {
  const was = state.relayWriterConnected;
  state.relayWriterConnected = connected;
  if (connected && !was) {
    state.lastRelayConnectAt = Date.now();
  } else if (!connected && was) {
    state.lastRelayDisconnectAt = Date.now();
  }
}

/** Set the relay READ/subscriber connection flag (Task 14). */
export function setRelaySubscriberConnected(connected: boolean): void {
  state.relaySubscriberConnected = connected;
}

// ── reader ──────────────────────────────────────────────────────────────────

export interface TgrMetricsSnapshot {
  publishOk: number;
  publishFailed: number;
  ackTimeouts: number;
  relayReconnects: number;
  relayWriterConnected: boolean;
  relaySubscriberConnected: boolean;
  lastRelayDisconnectAt: number | null;
  lastRelayConnectAt: number | null;
}

/** Snapshot of the current in-process counters + flags. */
export function getTgrMetricsSnapshot(): TgrMetricsSnapshot {
  return {
    publishOk: state.publishOk,
    publishFailed: state.publishFailed,
    ackTimeouts: state.ackTimeouts,
    relayReconnects: state.relayReconnects,
    relayWriterConnected: state.relayWriterConnected,
    relaySubscriberConnected: state.relaySubscriberConnected,
    lastRelayDisconnectAt: state.lastRelayDisconnectAt,
    lastRelayConnectAt: state.lastRelayConnectAt,
  };
}

/**
 * Reset the RATE counters after a cron emit (mirrors
 * `resetStabilizationCounters`). Connection flags + timestamps are point-in-time
 * gauges and are intentionally LEFT untouched (a reset must not "forget" that the
 * relay is currently down, nor when it disconnected).
 */
export function resetTgrCounters(): void {
  state.publishOk = 0;
  state.publishFailed = 0;
  state.ackTimeouts = 0;
  state.relayReconnects = 0;
}

/**
 * Full reset incl. flags/timestamps — TESTS ONLY (so a prior test's edges don't
 * leak into the next). Production code uses {@link resetTgrCounters}.
 */
export function __resetTgrMetricsForTests(): void {
  resetTgrCounters();
  state.relayWriterConnected = false;
  state.relaySubscriberConnected = false;
  state.lastRelayDisconnectAt = null;
  state.lastRelayConnectAt = null;
}

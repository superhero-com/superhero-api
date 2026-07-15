/**
 * Token-gated-rooms observability constants (Task 15, plan §13).
 *
 * Metric names, the alert-rule registry (name + default threshold env key), the
 * emit cron, and the two SLO definitions. Kept dependency-free so the in-memory
 * metrics module, the cron emitter service, the HTTP controller, and the unit
 * tests all import the SAME canonical names (no drift between the grep-friendly
 * log line, the JSON endpoint, and the alert evaluator).
 *
 * NOTE: this task ADDS machine-readable depth/lag/distribution/drift metrics on
 * top of the existing observability stack (in-memory counters like
 * `utils/stabilization-metrics.ts` + a `@Cron` log line like
 * `StabilizationService` + a `@Get` health JSON like `MdwController` + Bull
 * Board). It introduces NO new exporter/heavy dep (prom-client/OTel deferred to
 * Task 16, plan §13 / task §"Out of scope").
 */

import type { QueueOwner } from '../config/queue-prefix';
import { prefixQueue, TGR_QUEUE_NAMES } from '../config/queue-prefix';

/** Grep tags for the cron log lines (mirror `[StabilizationChecklist]`). */
export const TGR_METRICS_LOG_TAG = '[TgrMetrics]';
export const TGR_ALERT_LOG_TAG = '[TgrAlert]';

/** Default metrics-emit cron (1-min); overridable via `TG_METRICS_CRON`. */
export const TGR_METRICS_CRON_DEFAULT = '*/1 * * * *';

/**
 * Resolve the metrics-emit cron from env (`TG_METRICS_CRON`), falling back to
 * the 1-min default for blank/garbage. A bare 5-field crontab is accepted as-is;
 * anything else falls back so a typo can never silently disable the emitter.
 */
export function resolveMetricsCron(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env.TG_METRICS_CRON;
  if (raw === undefined || raw.trim() === '') {
    return TGR_METRICS_CRON_DEFAULT;
  }
  const value = raw.trim();
  // Accept a 5- or 6-field crontab expression; otherwise fall back.
  const fields = value.split(/\s+/);
  if (fields.length === 5 || fields.length === 6) {
    return value;
  }
  return TGR_METRICS_CRON_DEFAULT;
}

/**
 * The five canonical TGR queues, resolved to their PREFIXED names + the process
 * that consumes each (plan §9). The collector gauges depth/lag against these.
 *
 * `room-notify` is registered only inside the worker-only
 * `RoomNotificationsModule`, so its queue token is absent when the collector runs
 * in the main process — the queue injection is therefore `@Optional()` and its
 * depth is reported as `null` from main (documented in the controller).
 */
export interface TgrQueueDescriptor {
  /** Base name (`publish-nip29`, …). */
  base: string;
  /** Prefixed registered queue name (`worker:publish-nip29`, …). */
  name: string;
  /** Process that consumes (and therefore registers the @Processor for) it. */
  consumer: QueueOwner;
  /** Short key used in the log line / JSON (`publish`, `backfill`, …). */
  key: string;
}

export const TGR_METRICS_QUEUES: readonly TgrQueueDescriptor[] = [
  {
    base: TGR_QUEUE_NAMES.PUBLISH_NIP29,
    name: prefixQueue(TGR_QUEUE_NAMES.PUBLISH_NIP29, 'worker'),
    consumer: 'worker',
    key: 'publish',
  },
  {
    base: TGR_QUEUE_NAMES.ROOM_BACKFILL,
    name: prefixQueue(TGR_QUEUE_NAMES.ROOM_BACKFILL, 'worker'),
    consumer: 'worker',
    key: 'backfill',
  },
  {
    base: TGR_QUEUE_NAMES.RECONCILE_BALANCE,
    name: prefixQueue(TGR_QUEUE_NAMES.RECONCILE_BALANCE, 'main'),
    consumer: 'main',
    key: 'reconcile_balance',
  },
  {
    base: TGR_QUEUE_NAMES.RECONCILE_MEMBERSHIP,
    name: prefixQueue(TGR_QUEUE_NAMES.RECONCILE_MEMBERSHIP, 'worker'),
    consumer: 'worker',
    key: 'reconcile_membership',
  },
  {
    base: TGR_QUEUE_NAMES.ROOM_NOTIFY,
    name: prefixQueue(TGR_QUEUE_NAMES.ROOM_NOTIFY, 'worker'),
    consumer: 'worker',
    key: 'notify',
  },
] as const;

/** Severity ladder; `overallStatus` aggregates to the worst across all rules. */
export type AlertSeverity = 'ok' | 'warning' | 'critical';

/** Map an alert severity to the controller's `overallStatus` vocabulary. */
export type OverallStatus = 'healthy' | 'warning' | 'critical';

/**
 * Alert-rule identifiers (Req 4). Stable strings — they appear verbatim in the
 * `[TgrAlert] rule=<name> …` log line and in the JSON `alerts[]` array, so
 * dashboards/log filters key on them.
 */
export const TGR_ALERT_RULES = {
  FAILED_ROOM_RATIO: 'failed_room_ratio',
  DRIFT_RATIO: 'drift_ratio',
  STALE_RECONCILE: 'stale_reconcile',
  RELAY_DOWN: 'relay_down',
  QUEUE_BACKLOG: 'queue_backlog',
} as const;

/**
 * Threshold env keys + defaults (Req 5 env table, plan §18). Parsed by the
 * collector via the shared numeric parser; blank/garbage falls back to default.
 */
export const TGR_METRICS_THRESHOLD_DEFAULTS = {
  /** `failed_room_ratio` warning; critical at 2× (Req 4.1, plan §4.7). */
  failedRoomRatio: 0.05,
  /** `drift_ratio` warning (Req 4.2). */
  driftRatio: 0.02,
  /** `stale_reconcile` critical — §11 24h SLA (Req 4.3). */
  reconcileStaleSeconds: 86400,
  /** `relay_down` debounce seconds (Req 4.4). */
  relayDownAlertSeconds: 60,
  /** `queue_backlog` waiting-count warning; critical at 2× (Req 4.5). */
  queueBacklogThreshold: 5000,
  /** `queue_backlog` lag warning (ms, 5m); critical at 2× (Req 4.5). */
  queueLagAlertMs: 300000,
  /** `worker:room-notify` depth-break (§18 knob; alert against, owned elsewhere). */
  roomNotifyDepthBreak: 10000,
} as const;

/** Env var names for the thresholds (documented in `.env.example`). */
export const TGR_METRICS_THRESHOLD_ENV = {
  failedRoomRatio: 'TG_FAILED_ROOM_RATIO_THRESHOLD',
  driftRatio: 'TG_DRIFT_RATIO_THRESHOLD',
  reconcileStaleSeconds: 'TG_RECONCILE_STALE_SECONDS',
  relayDownAlertSeconds: 'TG_RELAY_DOWN_ALERT_SECONDS',
  queueBacklogThreshold: 'TG_QUEUE_BACKLOG_THRESHOLD',
  queueLagAlertMs: 'TG_QUEUE_LAG_ALERT_MS',
  roomNotifyDepthBreak: 'TG_ROOM_NOTIFY_DEPTH_BREAK',
} as const;

/**
 * SLO definitions (Req 7, plan §13) — codified so Task 16 cutover can gate on
 * them. These are documented thresholds (not enforced here); the proxy metric
 * that proves each is named so a dashboard can chart it.
 */
export const TGR_SLOS = {
  /**
   * SLO-1 — room created within T of token creation. T default 300s.
   * Proxy: `nostr_room_created_at − blockTime(community_room.created_height)`
   * over rooms reaching `nostr_room_state='created'`; alert when p95 > T.
   */
  roomCreatedWithinSeconds: 300,
  /**
   * SLO-2 — membership change published within U seconds. U default 60s.
   * Proxy: `room_membership.last_published_at − tgr.membership.changed` (and
   * `relay_state` reaching `added`/`removed`); alert when p95 > U.
   */
  membershipPublishedWithinSeconds: 60,
} as const;

/**
 * Pure metric math + alert evaluation + log-line formatting for the TGR
 * observability surface (Task 15). Kept dependency-free (no Nest, no TypeORM, no
 * bull import) so every branch unit-tests without a DI container or a DB — the
 * service injects the repos/queues and feeds raw rows into these helpers.
 *
 * Three responsibilities:
 *  1. shape the computed gauge values into a typed snapshot,
 *  2. evaluate the Req-4 alert rules (name + condition + severity) into a list,
 *  3. render the single grep-friendly `[TgrMetrics] key=value …` line (Req 2).
 */

import {
  AlertSeverity,
  OverallStatus,
  TGR_ALERT_RULES,
  TGR_METRICS_LOG_TAG,
  TGR_METRICS_QUEUES,
} from './tgr-metrics.constants';

/** Per-queue depth + lag gauge (Req 1.1). */
export interface QueueGauge {
  /** Short key (`publish`, `backfill`, …). */
  key: string;
  /** Prefixed queue name (`worker:publish-nip29`, …). */
  name: string;
  /** Waiting jobs (the "depth"); null when the queue is not registered here. */
  waiting: number | null;
  active: number | null;
  delayed: number | null;
  failed: number | null;
  /** `queue.isPaused()`; null when unknown. */
  paused: boolean | null;
  /** Age (ms) of the oldest waiting job (`now − head.timestamp`); null when none. */
  lagMs: number | null;
}

/** `room_membership.relay_state` distribution (Req 1.3). */
export interface RelayStateDistribution {
  pending_add: number;
  added: number;
  pending_remove: number;
  removed: number;
}

/** `Token.nostr_room_state` distribution (Req 1.4). */
export interface RoomStateDistribution {
  none: number;
  pending: number;
  created: number;
  failed: number;
  deleted: number;
}

/** Thresholds used by the alert evaluator (resolved from env by the service). */
export interface ResolvedThresholds {
  failedRoomRatio: number;
  driftRatio: number;
  reconcileStaleSeconds: number;
  relayDownAlertSeconds: number;
  queueBacklogThreshold: number;
  queueLagAlertMs: number;
  roomNotifyDepthBreak: number;
}

/** Inputs to {@link evaluateAlerts} — already-computed gauge numbers. */
export interface AlertInputs {
  roomFailed: number;
  roomTotal: number;
  driftCount: number;
  membershipTotal: number;
  reconcileMaxAgeS: number;
  reconcileStaleCount: number;
  relayWriterConnected: boolean;
  relaySubscriberConnected: boolean;
  /** Seconds the relay writer has been continuously down (0 when connected). */
  relayWriterDownSeconds: number;
  queues: QueueGauge[];
}

/** One fired alert (Req 4). */
export interface FiredAlert {
  rule: string;
  severity: Exclude<AlertSeverity, 'ok'>;
  value: number | string;
  threshold: number | string;
}

/** Divide guarding zero-total (Req: no NaN / divide-by-zero). */
export function safeRatio(numerator: number, denominator: number): number {
  if (!denominator || denominator <= 0) {
    return 0;
  }
  return numerator / denominator;
}

/** Percentage [0..100], two decimals, zero-total guarded. */
export function safePercent(part: number, total: number): number {
  return Number((safeRatio(part, total) * 100).toFixed(2));
}

/**
 * Worst of two severities along the ok < warning < critical ladder.
 */
export function worseSeverity(
  a: AlertSeverity,
  b: AlertSeverity,
): AlertSeverity {
  const rank: Record<AlertSeverity, number> = {
    ok: 0,
    warning: 1,
    critical: 2,
  };
  return rank[a] >= rank[b] ? a : b;
}

/** Map the worst fired severity to the controller's `overallStatus`. */
export function overallStatusFrom(alerts: FiredAlert[]): OverallStatus {
  let worst: AlertSeverity = 'ok';
  for (const a of alerts) {
    worst = worseSeverity(worst, a.severity);
  }
  return worst === 'ok' ? 'healthy' : worst;
}

/**
 * Evaluate every Req-4 alert rule against the computed inputs. Returns only the
 * rules that BREACHED, each with its value+threshold (so the cron emitter can log
 * `[TgrAlert] rule=… value=… threshold=…` and the JSON endpoint can list them).
 *
 * Severity escalation to `critical` at 2× the threshold is applied where Req 4
 * specifies it (`failed_room_ratio`, `queue_backlog`).
 */
export function evaluateAlerts(
  input: AlertInputs,
  t: ResolvedThresholds,
): FiredAlert[] {
  const alerts: FiredAlert[] = [];

  // 4.1 failed_room_ratio — warning; critical at 2×.
  const failedRatio = safeRatio(input.roomFailed, input.roomTotal);
  if (failedRatio > t.failedRoomRatio) {
    alerts.push({
      rule: TGR_ALERT_RULES.FAILED_ROOM_RATIO,
      severity: failedRatio > t.failedRoomRatio * 2 ? 'critical' : 'warning',
      value: Number(failedRatio.toFixed(4)),
      threshold: t.failedRoomRatio,
    });
  }

  // 4.2 drift_ratio — warning.
  const driftRatio = safeRatio(input.driftCount, input.membershipTotal);
  if (driftRatio > t.driftRatio) {
    alerts.push({
      rule: TGR_ALERT_RULES.DRIFT_RATIO,
      severity: 'warning',
      value: Number(driftRatio.toFixed(4)),
      threshold: t.driftRatio,
    });
  }

  // 4.3 stale_reconcile — critical when max-age > SLA OR any stale row.
  if (
    input.reconcileMaxAgeS > t.reconcileStaleSeconds ||
    input.reconcileStaleCount > 0
  ) {
    alerts.push({
      rule: TGR_ALERT_RULES.STALE_RECONCILE,
      severity: 'critical',
      value:
        input.reconcileStaleCount > 0
          ? `stale_count=${input.reconcileStaleCount}`
          : Math.round(input.reconcileMaxAgeS),
      threshold: t.reconcileStaleSeconds,
    });
  }

  // 4.4 relay_down — writer down past the debounce ⇒ critical;
  // subscriber-only down ⇒ warning. (Writer-down dominates.)
  if (
    !input.relayWriterConnected &&
    input.relayWriterDownSeconds >= t.relayDownAlertSeconds
  ) {
    alerts.push({
      rule: TGR_ALERT_RULES.RELAY_DOWN,
      severity: 'critical',
      value: `writer_down_s=${Math.round(input.relayWriterDownSeconds)}`,
      threshold: t.relayDownAlertSeconds,
    });
  } else if (input.relayWriterConnected && !input.relaySubscriberConnected) {
    alerts.push({
      rule: TGR_ALERT_RULES.RELAY_DOWN,
      severity: 'warning',
      value: 'subscriber_down',
      threshold: t.relayDownAlertSeconds,
    });
  }

  // 4.5 queue_backlog — any TGR queue waiting > threshold OR lag > lag-alert;
  // warning, critical at 2×. room-notify also has its own depth-break.
  for (const q of input.queues) {
    const waiting = q.waiting ?? 0;
    const lag = q.lagMs ?? 0;
    const isNotify = q.key === 'notify';

    const depthBreached = waiting > t.queueBacklogThreshold;
    const lagBreached = lag > t.queueLagAlertMs;
    if (depthBreached || lagBreached) {
      const depthCritical = waiting > t.queueBacklogThreshold * 2;
      const lagCritical = lag > t.queueLagAlertMs * 2;
      alerts.push({
        rule: TGR_ALERT_RULES.QUEUE_BACKLOG,
        severity: depthCritical || lagCritical ? 'critical' : 'warning',
        value: `${q.key} waiting=${waiting} lag_ms=${lag}`,
        threshold: `waiting>${t.queueBacklogThreshold} lag_ms>${t.queueLagAlertMs}`,
      });
    } else if (isNotify && waiting > t.roomNotifyDepthBreak) {
      // §18 depth-break (only meaningful if below the generic backlog threshold,
      // i.e. when the operator tuned the depth-break lower).
      alerts.push({
        rule: TGR_ALERT_RULES.QUEUE_BACKLOG,
        severity: 'warning',
        value: `notify waiting=${waiting}`,
        threshold: `notify_depth_break>${t.roomNotifyDepthBreak}`,
      });
    }
  }

  return alerts;
}

/**
 * The full computed metrics object (the JSON endpoint body + the source for the
 * log line). Every Req-1 metric appears here exactly once.
 */
export interface TgrMetricsReport {
  overallStatus: OverallStatus;
  /** Per-queue depth+lag (Req 1.1). */
  queues: QueueGauge[];
  /** Relay health (Req 1.2). */
  relay: {
    writerConnected: boolean;
    subscriberConnected: boolean;
    reconnects: number;
    lastDisconnectAt: number | null;
    writerDownSeconds: number;
  };
  /** relay_state distribution (Req 1.3). */
  relayState: RelayStateDistribution;
  /** nostr_room_state distribution (Req 1.4). */
  roomState: RoomStateDistribution;
  /** Postgres-vs-relay drift (Req 1.5). */
  drift: { count: number; ratio: number; membershipTotal: number };
  /** Reconciliation staleness (Req 1.6). */
  reconcile: { maxAgeSeconds: number; staleCount: number };
  /** Backfill progress (Req 1.7). */
  backfill: {
    created: number;
    total: number;
    failed: number;
    percent: number;
    cursorHeight: number | null;
  };
  /** Process-local rate counters (Req 1, accumulated in worker memory). */
  counters: {
    publishOk: number;
    publishFailed: number;
    ackTimeouts: number;
  };
  /** Fired alerts (Req 4). */
  alerts: FiredAlert[];
  /** Whether the worker-local counters/flags are served from the worker. */
  processLocal: boolean;
}

/**
 * Render the single grep-friendly `[TgrMetrics] key=value …` line (Req 2). Field
 * order/keys are fixed so a log filter (and the unit-test regex) can rely on
 * exactly-one occurrence of each key.
 */
export function formatMetricsLogLine(report: TgrMetricsReport): string {
  const byKey = new Map(report.queues.map((q) => [q.key, q]));
  const q = (key: string): QueueGauge | undefined => byKey.get(key);
  const depth = (key: string): string => `${q(key)?.waiting ?? 'n/a'}`;
  const lag = (key: string): string => `${q(key)?.lagMs ?? 'n/a'}`;

  const parts: string[] = [
    TGR_METRICS_LOG_TAG,
    `publish_q_depth=${depth('publish')}`,
    `publish_q_lag_ms=${lag('publish')}`,
    `backfill_q_depth=${depth('backfill')}`,
    `reconcile_balance_q_depth=${depth('reconcile_balance')}`,
    `reconcile_membership_q_depth=${depth('reconcile_membership')}`,
    `notify_q_depth=${depth('notify')}`,
    `relay_writer_connected=${report.relay.writerConnected}`,
    `relay_subscriber_connected=${report.relay.subscriberConnected}`,
    `relay_reconnects=${report.relay.reconnects}`,
    `ms_pending_add=${report.relayState.pending_add}`,
    `ms_added=${report.relayState.added}`,
    `ms_pending_remove=${report.relayState.pending_remove}`,
    `ms_removed=${report.relayState.removed}`,
    `room_none=${report.roomState.none}`,
    `room_pending=${report.roomState.pending}`,
    `room_created=${report.roomState.created}`,
    `room_failed=${report.roomState.failed}`,
    `room_deleted=${report.roomState.deleted}`,
    `drift_count=${report.drift.count}`,
    `drift_ratio=${report.drift.ratio}`,
    `reconcile_max_age_s=${report.reconcile.maxAgeSeconds}`,
    `reconcile_stale_count=${report.reconcile.staleCount}`,
    `backfill_created=${report.backfill.created}`,
    `backfill_total=${report.backfill.total}`,
    `backfill_pct=${report.backfill.percent}`,
    `publish_ok=${report.counters.publishOk}`,
    `publish_failed=${report.counters.publishFailed}`,
    `ack_timeouts=${report.counters.ackTimeouts}`,
  ];
  return parts.join(' ');
}

/** Render one `[TgrAlert] rule=… value=… threshold=… severity=…` line (Req 4). */
export function formatAlertLogLine(alert: FiredAlert): string {
  return `[TgrAlert] rule=${alert.rule} value=${alert.value} threshold=${alert.threshold} severity=${alert.severity}`;
}

/**
 * Build a {@link QueueGauge} from a raw `getJobCounts()` result + `isPaused()` +
 * the head-of-waiting job timestamp (Req 1.1 / test "queue gauge mapper").
 *
 * @param counts  bull v4 `{ waiting, active, completed, failed, delayed, paused }`
 * @param paused  `queue.isPaused()`
 * @param headWaitingTimestampMs epoch-ms of the oldest waiting job (null = none)
 * @param now     injected clock (defaults to Date.now) for deterministic tests
 */
export function mapQueueGauge(
  descriptor: { key: string; name: string },
  counts: Partial<Record<string, number>> | null,
  paused: boolean | null,
  headWaitingTimestampMs: number | null,
  now: number = Date.now(),
): QueueGauge {
  if (!counts) {
    return {
      key: descriptor.key,
      name: descriptor.name,
      waiting: null,
      active: null,
      delayed: null,
      failed: null,
      paused: null,
      lagMs: null,
    };
  }
  const lagMs =
    headWaitingTimestampMs != null
      ? Math.max(0, now - headWaitingTimestampMs)
      : null;
  return {
    key: descriptor.key,
    name: descriptor.name,
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    failed: counts.failed ?? 0,
    paused: paused ?? false,
    lagMs,
  };
}

/** All queue descriptors (re-exported for the service + tests). */
export const QUEUE_DESCRIPTORS = TGR_METRICS_QUEUES;

import { InjectQueue } from '@nestjs/bull';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bull';
import { Repository } from 'typeorm';
import { Token } from '@/tokens/entities/token.entity';
import tgrConfig from '../config/tgr.config';
import { prefixQueue, TGR_QUEUE_NAMES } from '../config/queue-prefix';
import { RoomMembership } from '../entities/room-membership.entity';
import { RoomBackfillState } from '../entities/room-backfill-state.entity';
import {
  evaluateAlerts,
  formatAlertLogLine,
  formatMetricsLogLine,
  mapQueueGauge,
  overallStatusFrom,
  QUEUE_DESCRIPTORS,
  QueueGauge,
  RelayStateDistribution,
  ResolvedThresholds,
  RoomStateDistribution,
  safePercent,
  safeRatio,
  TgrMetricsReport,
} from './tgr-metrics.collector';
import {
  resolveMetricsCron,
  TGR_METRICS_THRESHOLD_DEFAULTS,
  TGR_METRICS_THRESHOLD_ENV,
} from './tgr-metrics.constants';
import { getTgrMetricsSnapshot, resetTgrCounters } from './tgr-metrics';

/** Cron evaluated at decoration time; env override via `TG_METRICS_CRON`. */
const METRICS_CRON = resolveMetricsCron(process.env);

const MS_PER_SECOND = 1000;

/**
 * Token-gated-rooms observability collector + emitter (Task 15, plan §13).
 *
 * Composes the three existing observability patterns:
 *  - the in-memory counters in `tgr-metrics.ts` (process-local, worker memory),
 *  - a `@Cron(TG_METRICS_CRON)` that logs ONE grep-friendly `[TgrMetrics] …`
 *    line + any `[TgrAlert] …` breaches, then resets the rate counters
 *    (mirrors `StabilizationService`),
 *  - on-demand Postgres gauges (state distributions, drift, reconcile age,
 *    backfill progress) + Bull depth/lag, served to the controller as JSON
 *    (mirrors `MdwController.getHealth()`).
 *
 * Mode: `shared` — the same collector class constructs in BOTH processes. The
 * worker's tick carries authoritative relay counters/flags; the main process
 * serves the Postgres gauges to the read API (worker-local counters read as
 * their main-process values there — documented on the controller). Queue
 * injections are `@Optional()` so a queue absent in the current process (e.g.
 * `worker:room-notify`, registered only in the worker) yields a `null` depth
 * rather than a DI failure.
 *
 * Boot-safe: NOTHING is scheduled/enqueued in a lifecycle hook — the only
 * recurring work is the read-only `@Cron`, which never enqueues and only reads.
 */
@Injectable()
export class TgrMetricsService {
  private readonly logger = new Logger(TgrMetricsService.name);
  private readonly thresholds: ResolvedThresholds;
  private readonly queueByKey: Map<string, Queue | undefined>;

  constructor(
    @InjectRepository(RoomMembership)
    private readonly membershipRepo: Repository<RoomMembership>,
    @InjectRepository(Token)
    private readonly tokenRepo: Repository<Token>,
    @InjectRepository(RoomBackfillState)
    private readonly backfillStateRepo: Repository<RoomBackfillState>,
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
    @Optional()
    @InjectQueue(prefixQueue(TGR_QUEUE_NAMES.PUBLISH_NIP29, 'worker'))
    private readonly publishQueue?: Queue,
    @Optional()
    @InjectQueue(prefixQueue(TGR_QUEUE_NAMES.ROOM_BACKFILL, 'worker'))
    private readonly backfillQueue?: Queue,
    @Optional()
    @InjectQueue(prefixQueue(TGR_QUEUE_NAMES.RECONCILE_BALANCE, 'main'))
    private readonly reconcileBalanceQueue?: Queue,
    @Optional()
    @InjectQueue(prefixQueue(TGR_QUEUE_NAMES.RECONCILE_MEMBERSHIP, 'worker'))
    private readonly reconcileMembershipQueue?: Queue,
    @Optional()
    @InjectQueue(prefixQueue(TGR_QUEUE_NAMES.ROOM_NOTIFY, 'worker'))
    private readonly roomNotifyQueue?: Queue,
  ) {
    this.thresholds = this.resolveThresholds(process.env);
    this.queueByKey = new Map([
      ['publish', this.publishQueue],
      ['backfill', this.backfillQueue],
      ['reconcile_balance', this.reconcileBalanceQueue],
      ['reconcile_membership', this.reconcileMembershipQueue],
      ['notify', this.roomNotifyQueue],
    ]);
  }

  /** The resolved alert thresholds (tests/observability). */
  getThresholds(): ResolvedThresholds {
    return this.thresholds;
  }

  /**
   * Cron emitter (Req 2/4): compute the report, log ONE `[TgrMetrics] …` line,
   * log a `[TgrAlert] …` line per breached rule, then reset ONLY the rate
   * counters (gauges + flags persist). Mirrors `StabilizationService`.
   */
  @Cron(METRICS_CRON)
  async emitMetrics(): Promise<void> {
    let report: TgrMetricsReport;
    try {
      report = await this.collect();
    } catch (error: any) {
      // Never let a transient gauge-query error wedge the cron; log + bail.
      this.logger.error(
        `metrics collection failed: ${error?.message ?? error}`,
      );
      return;
    }

    this.logger.log(formatMetricsLogLine(report));
    for (const alert of report.alerts) {
      this.logger.warn(formatAlertLogLine(alert));
    }
    resetTgrCounters();
  }

  /**
   * Compute the full metrics report (the controller body + the cron source).
   * Read-only: indexed `GROUP BY`/counts + Bull `getJobCounts()` — no full scans,
   * no relay reads (drift uses the STORED ledger, not a live `39002` read).
   *
   * @param processLocal whether the worker-local counters/flags are authoritative
   *   in this process (true in the worker; the controller passes false from main).
   */
  async collect(processLocal = true): Promise<TgrMetricsReport> {
    const [
      queues,
      relayState,
      roomState,
      membershipTotal,
      reconcile,
      backfill,
    ] = await Promise.all([
      this.collectQueueGauges(),
      this.collectRelayStateDistribution(),
      this.collectRoomStateDistribution(),
      this.membershipRepo.count(),
      this.collectReconcileAge(),
      this.collectBackfillProgress(),
    ]);

    const driftCount = relayState.pending_add + relayState.pending_remove;
    const snapshot = getTgrMetricsSnapshot();

    const writerDownSeconds =
      !snapshot.relayWriterConnected && snapshot.lastRelayDisconnectAt != null
        ? Math.max(
            0,
            (Date.now() - snapshot.lastRelayDisconnectAt) / MS_PER_SECOND,
          )
        : 0;

    const alerts = evaluateAlerts(
      {
        roomFailed: roomState.failed,
        roomTotal:
          roomState.none +
          roomState.pending +
          roomState.created +
          roomState.failed +
          roomState.deleted,
        driftCount,
        membershipTotal,
        reconcileMaxAgeS: reconcile.maxAgeSeconds,
        reconcileStaleCount: reconcile.staleCount,
        relayWriterConnected: snapshot.relayWriterConnected,
        relaySubscriberConnected: snapshot.relaySubscriberConnected,
        relayWriterDownSeconds: writerDownSeconds,
        queues,
      },
      this.thresholds,
    );

    return {
      overallStatus: overallStatusFrom(alerts),
      queues,
      relay: {
        writerConnected: snapshot.relayWriterConnected,
        subscriberConnected: snapshot.relaySubscriberConnected,
        reconnects: snapshot.relayReconnects,
        lastDisconnectAt: snapshot.lastRelayDisconnectAt,
        writerDownSeconds: Number(writerDownSeconds.toFixed(0)),
      },
      relayState,
      roomState,
      drift: {
        count: driftCount,
        ratio: Number(safeRatio(driftCount, membershipTotal).toFixed(4)),
        membershipTotal,
      },
      reconcile,
      backfill,
      counters: {
        publishOk: snapshot.publishOk,
        publishFailed: snapshot.publishFailed,
        ackTimeouts: snapshot.ackTimeouts,
      },
      alerts,
      processLocal,
    };
  }

  // ── gauge collectors ────────────────────────────────────────────────────────

  /** Per-queue depth + lag (Req 1.1). Absent queues map to all-`null`. */
  private async collectQueueGauges(): Promise<QueueGauge[]> {
    const now = Date.now();
    return Promise.all(
      QUEUE_DESCRIPTORS.map(async (d) => {
        const queue = this.queueByKey.get(d.key);
        if (!queue) {
          return mapQueueGauge(d, null, null, null, now);
        }
        try {
          const [counts, paused, head] = await Promise.all([
            queue.getJobCounts(),
            typeof queue.isPaused === 'function' ? queue.isPaused() : false,
            this.headWaitingTimestamp(queue),
          ]);
          return mapQueueGauge(d, counts as any, paused, head, now);
        } catch (error: any) {
          this.logger.debug(
            `queue gauge ${d.name} failed: ${error?.message ?? error}`,
          );
          return mapQueueGauge(d, null, null, null, now);
        }
      }),
    );
  }

  /** Oldest waiting job's `timestamp` (ms) for lag, or null when none. */
  private async headWaitingTimestamp(queue: Queue): Promise<number | null> {
    try {
      // bull v4: getWaiting(start, end) — fetch only the head (oldest) job.
      const head = await queue.getWaiting(0, 0);
      const job = Array.isArray(head) ? head[0] : undefined;
      const ts = job?.timestamp;
      return typeof ts === 'number' && Number.isFinite(ts) ? ts : null;
    } catch {
      return null;
    }
  }

  /** `room_membership.relay_state` distribution (Req 1.3). */
  private async collectRelayStateDistribution(): Promise<RelayStateDistribution> {
    const rows = await this.membershipRepo
      .createQueryBuilder('m')
      .select('m.relay_state', 'relay_state')
      .addSelect('COUNT(*)', 'count')
      .groupBy('m.relay_state')
      .getRawMany<{ relay_state: string; count: string }>();

    const dist: RelayStateDistribution = {
      pending_add: 0,
      added: 0,
      pending_remove: 0,
      removed: 0,
    };
    for (const row of rows) {
      if (row.relay_state in dist) {
        dist[row.relay_state as keyof RelayStateDistribution] = Number(
          row.count,
        );
      }
    }
    return dist;
  }

  /** `Token.nostr_room_state` distribution (Req 1.4). */
  private async collectRoomStateDistribution(): Promise<RoomStateDistribution> {
    const rows = await this.tokenRepo
      .createQueryBuilder('t')
      .select('t.nostr_room_state', 'state')
      .addSelect('COUNT(*)', 'count')
      .groupBy('t.nostr_room_state')
      .getRawMany<{ state: string; count: string }>();

    const dist: RoomStateDistribution = {
      none: 0,
      pending: 0,
      created: 0,
      failed: 0,
      deleted: 0,
    };
    for (const row of rows) {
      if (row.state in dist) {
        dist[row.state as keyof RoomStateDistribution] = Number(row.count);
      }
    }
    return dist;
  }

  /**
   * Reconciliation staleness (Req 1.6): max age of the oldest
   * `last_reconciled_at` (seconds) + count of rows older than the SLA. A NULL
   * `last_reconciled_at` (never reconciled) counts as stale and pins max-age to
   * the SLA boundary so the `stale_reconcile` alert fires.
   */
  private async collectReconcileAge(): Promise<{
    maxAgeSeconds: number;
    staleCount: number;
  }> {
    const staleSeconds = this.thresholds.reconcileStaleSeconds;
    const row = await this.membershipRepo
      .createQueryBuilder('m')
      .select('MIN(m.last_reconciled_at)', 'oldest')
      .addSelect(
        'COUNT(*) FILTER (WHERE m.last_reconciled_at IS NULL)',
        'never',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE m.last_reconciled_at IS NULL OR m.last_reconciled_at < (NOW() - (:stale || ' seconds')::interval))`,
        'stale',
      )
      .addSelect('COUNT(*)', 'total')
      .setParameter('stale', staleSeconds)
      .getRawOne<{
        oldest: Date | null;
        never: string;
        stale: string;
        total: string;
      }>();

    const total = Number(row?.total ?? 0);
    const never = Number(row?.never ?? 0);
    const staleCount = Number(row?.stale ?? 0);

    let maxAgeSeconds = 0;
    if (total === 0) {
      maxAgeSeconds = 0;
    } else if (never > 0) {
      // Never-reconciled rows are maximally stale; report just over the SLA so
      // the alert fires without serializing Infinity to JSON.
      maxAgeSeconds = staleSeconds + 1;
    } else if (row?.oldest) {
      maxAgeSeconds = Math.max(
        0,
        Math.round(
          (Date.now() - new Date(row.oldest).getTime()) / MS_PER_SECOND,
        ),
      );
    }

    return { maxAgeSeconds, staleCount };
  }

  /**
   * Backfill progress (Req 1.7): created/total/failed + percentage, tied to the
   * `room_backfill_state` cursor height when present.
   */
  private async collectBackfillProgress(): Promise<{
    created: number;
    total: number;
    failed: number;
    percent: number;
    cursorHeight: number | null;
  }> {
    const [total, created, failed, cursor] = await Promise.all([
      this.tokenRepo.count(),
      this.tokenRepo.count({ where: { nostr_room_state: 'created' as any } }),
      this.tokenRepo.count({ where: { nostr_room_state: 'failed' as any } }),
      this.backfillStateRepo
        .findOne({ where: { id: 'global' } })
        .catch(() => null),
    ]);

    return {
      created,
      total,
      failed,
      percent: safePercent(created, total),
      cursorHeight: cursor?.last_height ?? null,
    };
  }

  // ── env parsing ───────────────────────────────────────────────────────────

  /** Resolve the alert thresholds from env, falling back to the §18 defaults. */
  private resolveThresholds(
    env: Record<string, string | undefined>,
  ): ResolvedThresholds {
    const num = (key: string, fallback: number): number => {
      const raw = env[key];
      if (raw === undefined || raw.trim() === '') {
        return fallback;
      }
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    };
    return {
      failedRoomRatio: num(
        TGR_METRICS_THRESHOLD_ENV.failedRoomRatio,
        TGR_METRICS_THRESHOLD_DEFAULTS.failedRoomRatio,
      ),
      driftRatio: num(
        TGR_METRICS_THRESHOLD_ENV.driftRatio,
        TGR_METRICS_THRESHOLD_DEFAULTS.driftRatio,
      ),
      reconcileStaleSeconds: num(
        TGR_METRICS_THRESHOLD_ENV.reconcileStaleSeconds,
        TGR_METRICS_THRESHOLD_DEFAULTS.reconcileStaleSeconds,
      ),
      relayDownAlertSeconds: num(
        TGR_METRICS_THRESHOLD_ENV.relayDownAlertSeconds,
        TGR_METRICS_THRESHOLD_DEFAULTS.relayDownAlertSeconds,
      ),
      queueBacklogThreshold: num(
        TGR_METRICS_THRESHOLD_ENV.queueBacklogThreshold,
        TGR_METRICS_THRESHOLD_DEFAULTS.queueBacklogThreshold,
      ),
      queueLagAlertMs: num(
        TGR_METRICS_THRESHOLD_ENV.queueLagAlertMs,
        TGR_METRICS_THRESHOLD_DEFAULTS.queueLagAlertMs,
      ),
      // TG_ROOM_NOTIFY_DEPTH_BREAK is owned by tgrConfig (§18); read it from there so
      // the alert tracks the SAME value the circuit-breaker uses.
      roomNotifyDepthBreak:
        this.config?.roomNotifyDepthBreak ??
        TGR_METRICS_THRESHOLD_DEFAULTS.roomNotifyDepthBreak,
    };
  }
}

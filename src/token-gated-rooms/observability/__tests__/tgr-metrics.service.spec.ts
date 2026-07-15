import { Logger } from '@nestjs/common';
import { TgrMetricsService } from '../tgr-metrics.service';
import {
  __resetTgrMetricsForTests,
  incrementPublishOk,
  setRelayWriterConnected,
} from '../tgr-metrics';

/**
 * Build a stub TypeORM repository whose query-builder + count behaviour is
 * scripted per test. We bypass DI and construct the service directly with these
 * stubs so the gauge math is exercised without a Postgres connection.
 */
function makeMembershipRepo(opts: {
  relayStateRows?: { relay_state: string; count: string }[];
  total?: number;
  reconcileRow?: {
    oldest: Date | null;
    never: string;
    stale: string;
    total: string;
  };
}): any {
  const qb: any = {
    select: () => qb,
    addSelect: () => qb,
    groupBy: () => qb,
    setParameter: () => qb,
    getRawMany: async () => opts.relayStateRows ?? [],
    getRawOne: async () =>
      opts.reconcileRow ?? {
        oldest: null,
        never: '0',
        stale: '0',
        total: '0',
      },
  };
  return {
    createQueryBuilder: () => qb,
    count: async () => opts.total ?? 0,
  };
}

function makeTokenRepo(opts: {
  roomStateRows?: { state: string; count: string }[];
  total?: number;
  created?: number;
  failed?: number;
}): any {
  const qb: any = {
    select: () => qb,
    addSelect: () => qb,
    groupBy: () => qb,
    getRawMany: async () => opts.roomStateRows ?? [],
  };
  return {
    createQueryBuilder: () => qb,
    count: async (arg?: any) => {
      const state = arg?.where?.nostr_room_state;
      if (state === 'created') return opts.created ?? 0;
      if (state === 'failed') return opts.failed ?? 0;
      return opts.total ?? 0;
    },
  };
}

function makeBackfillRepo(lastHeight: number | null): any {
  return {
    findOne: async () =>
      lastHeight == null ? null : { last_height: lastHeight },
  };
}

const CONFIG = { roomNotifyDepthBreak: 10000 } as any;

function makeQueue(
  counts: Record<string, number>,
  paused = false,
  headTs: number | null = null,
): any {
  return {
    getJobCounts: async () => counts,
    isPaused: async () => paused,
    getWaiting: async () => (headTs == null ? [] : [{ timestamp: headTs }]),
  };
}

describe('TgrMetricsService.collect', () => {
  beforeEach(() => {
    __resetTgrMetricsForTests();
    // Quiet the cron logger noise.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('computes distributions, drift, reconcile age, backfill from stubbed rows', async () => {
    const membershipRepo = makeMembershipRepo({
      relayStateRows: [
        { relay_state: 'pending_add', count: '3' },
        { relay_state: 'added', count: '10' },
        { relay_state: 'pending_remove', count: '1' },
        { relay_state: 'removed', count: '6' },
      ],
      total: 20,
      reconcileRow: { oldest: null, never: '0', stale: '0', total: '20' },
    });
    const tokenRepo = makeTokenRepo({
      roomStateRows: [
        { state: 'none', count: '2' },
        { state: 'created', count: '7' },
        { state: 'failed', count: '1' },
      ],
      total: 10,
      created: 7,
      failed: 1,
    });

    const service = new TgrMetricsService(
      membershipRepo,
      tokenRepo,
      makeBackfillRepo(42),
      CONFIG,
    );

    const report = await service.collect(true);

    expect(report.relayState).toEqual({
      pending_add: 3,
      added: 10,
      pending_remove: 1,
      removed: 6,
    });
    expect(report.roomState).toMatchObject({
      none: 2,
      created: 7,
      failed: 1,
    });
    // drift = pending_add + pending_remove = 4; ratio = 4/20 = 0.2
    expect(report.drift.count).toBe(4);
    expect(report.drift.ratio).toBeCloseTo(0.2, 5);
    expect(report.drift.membershipTotal).toBe(20);
    // backfill: created 7 / total 10 → 70%
    expect(report.backfill).toMatchObject({
      created: 7,
      total: 10,
      failed: 1,
      percent: 70,
      cursorHeight: 42,
    });
  });

  it('never-reconciled rows pin max-age over the SLA and fire stale_reconcile', async () => {
    const membershipRepo = makeMembershipRepo({
      total: 5,
      reconcileRow: { oldest: null, never: '5', stale: '5', total: '5' },
    });
    const tokenRepo = makeTokenRepo({ total: 0 });
    const service = new TgrMetricsService(
      membershipRepo,
      tokenRepo,
      makeBackfillRepo(null),
      CONFIG,
    );

    const report = await service.collect(true);
    expect(report.reconcile.staleCount).toBe(5);
    expect(report.reconcile.maxAgeSeconds).toBeGreaterThan(
      service.getThresholds().reconcileStaleSeconds,
    );
    expect(report.alerts.some((a) => a.rule === 'stale_reconcile')).toBe(true);
    expect(report.overallStatus).toBe('critical');
  });

  it('zero-total guards: empty DB → no NaN, healthy status', async () => {
    const membershipRepo = makeMembershipRepo({
      total: 0,
      reconcileRow: { oldest: null, never: '0', stale: '0', total: '0' },
    });
    const tokenRepo = makeTokenRepo({ total: 0 });
    const service = new TgrMetricsService(
      membershipRepo,
      tokenRepo,
      makeBackfillRepo(null),
      CONFIG,
    );

    const report = await service.collect(true);
    expect(Number.isNaN(report.drift.ratio)).toBe(false);
    expect(report.drift.ratio).toBe(0);
    expect(report.backfill.percent).toBe(0);
    expect(report.reconcile.maxAgeSeconds).toBe(0);
    expect(report.overallStatus).toBe('healthy');
  });

  it('reads queue depth + lag from injected queues', async () => {
    const now = Date.now();
    const membershipRepo = makeMembershipRepo({
      total: 0,
      reconcileRow: { oldest: null, never: '0', stale: '0', total: '0' },
    });
    const tokenRepo = makeTokenRepo({ total: 0 });
    const publishQueue = makeQueue(
      { waiting: 42, active: 1, delayed: 0, failed: 0 },
      true,
      now - 2000,
    );

    const service = new TgrMetricsService(
      membershipRepo,
      tokenRepo,
      makeBackfillRepo(null),
      CONFIG,
      publishQueue, // publish
    );

    const report = await service.collect(true);
    const publish = report.queues.find((q) => q.key === 'publish');
    expect(publish?.waiting).toBe(42);
    expect(publish?.paused).toBe(true);
    expect(publish?.lagMs).toBeGreaterThanOrEqual(2000);

    // Un-injected queues report null depth (not a crash).
    const notify = report.queues.find((q) => q.key === 'notify');
    expect(notify?.waiting).toBeNull();
  });

  it('emitMetrics logs the [TgrMetrics] line and resets rate counters', async () => {
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);

    const membershipRepo = makeMembershipRepo({
      total: 0,
      reconcileRow: { oldest: null, never: '0', stale: '0', total: '0' },
    });
    const tokenRepo = makeTokenRepo({ total: 0 });
    const service = new TgrMetricsService(
      membershipRepo,
      tokenRepo,
      makeBackfillRepo(null),
      CONFIG,
    );

    incrementPublishOk();
    setRelayWriterConnected(true);

    await service.emitMetrics();

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    const metricLine = lines.find((l) => l.startsWith('[TgrMetrics]'));
    expect(metricLine).toBeDefined();
    expect(metricLine).toContain('publish_ok=1');

    // After emit, the rate counter is reset but the flag persists.
    const report = await service.collect(true);
    expect(report.counters.publishOk).toBe(0);
    expect(report.relay.writerConnected).toBe(true);
  });

  it('emitMetrics logs a [TgrAlert] warn line per breached rule', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const membershipRepo = makeMembershipRepo({
      relayStateRows: [{ relay_state: 'pending_add', count: '50' }],
      total: 100, // drift 50/100 = 0.5 > 0.02
      reconcileRow: { oldest: null, never: '0', stale: '0', total: '100' },
    });
    const tokenRepo = makeTokenRepo({ total: 0 });
    const service = new TgrMetricsService(
      membershipRepo,
      tokenRepo,
      makeBackfillRepo(null),
      CONFIG,
    );

    await service.emitMetrics();

    const warns = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(
      warns.some(
        (l) => l.startsWith('[TgrAlert]') && l.includes('drift_ratio'),
      ),
    ).toBe(true);
  });
});

describe('TgrMetricsService.resolveThresholds (env)', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    'TG_FAILED_ROOM_RATIO_THRESHOLD',
    'TG_DRIFT_RATIO_THRESHOLD',
    'TG_RECONCILE_STALE_SECONDS',
    'TG_RELAY_DOWN_ALERT_SECONDS',
    'TG_QUEUE_BACKLOG_THRESHOLD',
    'TG_QUEUE_LAG_ALERT_MS',
  ];

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('falls back to §18 defaults when env is unset', () => {
    const service = new TgrMetricsService(
      makeMembershipRepo({}),
      makeTokenRepo({}),
      makeBackfillRepo(null),
      CONFIG,
    );
    expect(service.getThresholds()).toMatchObject({
      failedRoomRatio: 0.05,
      driftRatio: 0.02,
      reconcileStaleSeconds: 86400,
      relayDownAlertSeconds: 60,
      queueBacklogThreshold: 5000,
      queueLagAlertMs: 300000,
      roomNotifyDepthBreak: 10000,
    });
  });

  it('reads overrides from env (garbage falls back)', () => {
    process.env.TG_DRIFT_RATIO_THRESHOLD = '0.1';
    process.env.TG_QUEUE_BACKLOG_THRESHOLD = 'not-a-number';
    const service = new TgrMetricsService(
      makeMembershipRepo({}),
      makeTokenRepo({}),
      makeBackfillRepo(null),
      CONFIG,
    );
    expect(service.getThresholds().driftRatio).toBe(0.1);
    expect(service.getThresholds().queueBacklogThreshold).toBe(5000);
  });
});

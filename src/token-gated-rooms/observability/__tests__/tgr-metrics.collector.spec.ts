import {
  AlertInputs,
  evaluateAlerts,
  formatAlertLogLine,
  formatMetricsLogLine,
  FiredAlert,
  mapQueueGauge,
  overallStatusFrom,
  QueueGauge,
  ResolvedThresholds,
  safePercent,
  safeRatio,
  TgrMetricsReport,
  worseSeverity,
} from '../tgr-metrics.collector';
import { TGR_ALERT_RULES } from '../tgr-metrics.constants';

const THRESHOLDS: ResolvedThresholds = {
  failedRoomRatio: 0.05,
  driftRatio: 0.02,
  reconcileStaleSeconds: 86400,
  relayDownAlertSeconds: 60,
  queueBacklogThreshold: 5000,
  queueLagAlertMs: 300000,
  roomNotifyDepthBreak: 10000,
};

const emptyQueues: QueueGauge[] = [];

function baseInputs(over: Partial<AlertInputs> = {}): AlertInputs {
  return {
    roomFailed: 0,
    roomTotal: 1000,
    driftCount: 0,
    membershipTotal: 1000,
    reconcileMaxAgeS: 0,
    reconcileStaleCount: 0,
    relayWriterConnected: true,
    relaySubscriberConnected: true,
    relayWriterDownSeconds: 0,
    queues: emptyQueues,
    ...over,
  };
}

function ruleOf(alerts: FiredAlert[], rule: string): FiredAlert | undefined {
  return alerts.find((a) => a.rule === rule);
}

describe('safeRatio / safePercent (zero-total guards)', () => {
  it('guards divide-by-zero → 0, never NaN', () => {
    expect(safeRatio(5, 0)).toBe(0);
    expect(safePercent(5, 0)).toBe(0);
    expect(Number.isNaN(safeRatio(0, 0))).toBe(false);
  });

  it('computes correctly otherwise', () => {
    expect(safeRatio(1, 4)).toBe(0.25);
    expect(safePercent(1, 4)).toBe(25);
    expect(safePercent(1, 3)).toBe(33.33);
  });
});

describe('worseSeverity / overallStatusFrom', () => {
  it('picks the worse of two severities', () => {
    expect(worseSeverity('ok', 'warning')).toBe('warning');
    expect(worseSeverity('warning', 'critical')).toBe('critical');
    expect(worseSeverity('critical', 'warning')).toBe('critical');
  });

  it('aggregates the alert list to the worst severity', () => {
    expect(overallStatusFrom([])).toBe('healthy');
    expect(
      overallStatusFrom([
        { rule: 'a', severity: 'warning', value: 1, threshold: 0 },
      ]),
    ).toBe('warning');
    expect(
      overallStatusFrom([
        { rule: 'a', severity: 'warning', value: 1, threshold: 0 },
        { rule: 'b', severity: 'critical', value: 1, threshold: 0 },
      ]),
    ).toBe('critical');
  });
});

describe('mapQueueGauge', () => {
  it('computes depth fields + lag = now − head.timestamp', () => {
    const now = 1_000_000;
    const gauge = mapQueueGauge(
      { key: 'publish', name: 'worker:publish-nip29' },
      { waiting: 7, active: 1, delayed: 2, failed: 3 },
      true,
      now - 4500,
      now,
    );
    expect(gauge.waiting).toBe(7);
    expect(gauge.active).toBe(1);
    expect(gauge.delayed).toBe(2);
    expect(gauge.failed).toBe(3);
    expect(gauge.paused).toBe(true);
    expect(gauge.lagMs).toBe(4500);
  });

  it('lag is null when there is no waiting job', () => {
    const gauge = mapQueueGauge(
      { key: 'backfill', name: 'worker:room-backfill' },
      { waiting: 0 },
      false,
      null,
      1000,
    );
    expect(gauge.lagMs).toBeNull();
    expect(gauge.waiting).toBe(0);
  });

  it('absent queue (null counts) → all-null gauge', () => {
    const gauge = mapQueueGauge(
      { key: 'notify', name: 'worker:room-notify' },
      null,
      null,
      null,
    );
    expect(gauge).toMatchObject({
      key: 'notify',
      waiting: null,
      paused: null,
      lagMs: null,
    });
  });

  it('clamps negative lag (clock skew) to 0', () => {
    const gauge = mapQueueGauge(
      { key: 'publish', name: 'worker:publish-nip29' },
      { waiting: 1 },
      false,
      2000, // head timestamp in the "future"
      1000,
    );
    expect(gauge.lagMs).toBe(0);
  });
});

describe('evaluateAlerts — table-driven (Req 4)', () => {
  it('stays quiet when everything is within thresholds', () => {
    expect(evaluateAlerts(baseInputs(), THRESHOLDS)).toEqual([]);
  });

  // 4.1 failed_room_ratio
  it('failed_room_ratio: fires warning above threshold, critical at 2×', () => {
    // 6% > 5% → warning (not yet 2×=10%)
    const warn = evaluateAlerts(
      baseInputs({ roomFailed: 60, roomTotal: 1000 }),
      THRESHOLDS,
    );
    expect(ruleOf(warn, TGR_ALERT_RULES.FAILED_ROOM_RATIO)?.severity).toBe(
      'warning',
    );
    // 11% > 10% → critical
    const crit = evaluateAlerts(
      baseInputs({ roomFailed: 110, roomTotal: 1000 }),
      THRESHOLDS,
    );
    expect(ruleOf(crit, TGR_ALERT_RULES.FAILED_ROOM_RATIO)?.severity).toBe(
      'critical',
    );
    // exactly at threshold → quiet (strictly greater)
    const quiet = evaluateAlerts(
      baseInputs({ roomFailed: 50, roomTotal: 1000 }),
      THRESHOLDS,
    );
    expect(ruleOf(quiet, TGR_ALERT_RULES.FAILED_ROOM_RATIO)).toBeUndefined();
  });

  // 4.2 drift_ratio
  it('drift_ratio: warning above threshold; quiet at/below', () => {
    const fire = evaluateAlerts(
      baseInputs({ driftCount: 30, membershipTotal: 1000 }),
      THRESHOLDS,
    );
    expect(ruleOf(fire, TGR_ALERT_RULES.DRIFT_RATIO)?.severity).toBe('warning');
    const quiet = evaluateAlerts(
      baseInputs({ driftCount: 20, membershipTotal: 1000 }),
      THRESHOLDS,
    );
    expect(ruleOf(quiet, TGR_ALERT_RULES.DRIFT_RATIO)).toBeUndefined();
  });

  // 4.3 stale_reconcile
  it('stale_reconcile: critical when max-age > SLA or any stale row', () => {
    const byAge = evaluateAlerts(
      baseInputs({ reconcileMaxAgeS: 86401 }),
      THRESHOLDS,
    );
    expect(ruleOf(byAge, TGR_ALERT_RULES.STALE_RECONCILE)?.severity).toBe(
      'critical',
    );
    const byCount = evaluateAlerts(
      baseInputs({ reconcileMaxAgeS: 0, reconcileStaleCount: 3 }),
      THRESHOLDS,
    );
    expect(ruleOf(byCount, TGR_ALERT_RULES.STALE_RECONCILE)?.severity).toBe(
      'critical',
    );
    const quiet = evaluateAlerts(
      baseInputs({ reconcileMaxAgeS: 86400, reconcileStaleCount: 0 }),
      THRESHOLDS,
    );
    expect(ruleOf(quiet, TGR_ALERT_RULES.STALE_RECONCILE)).toBeUndefined();
  });

  // 4.4 relay_down (debounce)
  it('relay_down: writer down past debounce → critical; within debounce → quiet', () => {
    const debounced = evaluateAlerts(
      baseInputs({ relayWriterConnected: false, relayWriterDownSeconds: 30 }),
      THRESHOLDS,
    );
    expect(ruleOf(debounced, TGR_ALERT_RULES.RELAY_DOWN)).toBeUndefined();

    const fired = evaluateAlerts(
      baseInputs({ relayWriterConnected: false, relayWriterDownSeconds: 61 }),
      THRESHOLDS,
    );
    expect(ruleOf(fired, TGR_ALERT_RULES.RELAY_DOWN)?.severity).toBe(
      'critical',
    );
  });

  it('relay_down: subscriber-only down → warning (writer up)', () => {
    const fired = evaluateAlerts(
      baseInputs({
        relayWriterConnected: true,
        relaySubscriberConnected: false,
      }),
      THRESHOLDS,
    );
    expect(ruleOf(fired, TGR_ALERT_RULES.RELAY_DOWN)?.severity).toBe('warning');
  });

  // 4.5 queue_backlog
  it('queue_backlog: depth above threshold → warning, 2× → critical', () => {
    const warn = evaluateAlerts(
      baseInputs({
        queues: [
          mapQueueGauge(
            { key: 'publish', name: 'worker:publish-nip29' },
            { waiting: 6000 },
            false,
            null,
            1000,
          ),
        ],
      }),
      THRESHOLDS,
    );
    expect(ruleOf(warn, TGR_ALERT_RULES.QUEUE_BACKLOG)?.severity).toBe(
      'warning',
    );

    const crit = evaluateAlerts(
      baseInputs({
        queues: [
          mapQueueGauge(
            { key: 'publish', name: 'worker:publish-nip29' },
            { waiting: 10001 },
            false,
            null,
            1000,
          ),
        ],
      }),
      THRESHOLDS,
    );
    expect(ruleOf(crit, TGR_ALERT_RULES.QUEUE_BACKLOG)?.severity).toBe(
      'critical',
    );
  });

  it('queue_backlog: lag above threshold also fires', () => {
    const fired = evaluateAlerts(
      baseInputs({
        queues: [
          mapQueueGauge(
            { key: 'backfill', name: 'worker:room-backfill' },
            { waiting: 1 },
            false,
            1000 - 400000, // 400s old > 300s threshold
            1000,
          ),
        ],
      }),
      THRESHOLDS,
    );
    expect(ruleOf(fired, TGR_ALERT_RULES.QUEUE_BACKLOG)?.severity).toBe(
      'warning',
    );
  });

  it('queue_backlog: room-notify depth-break fires below generic threshold', () => {
    const tighter: ResolvedThresholds = {
      ...THRESHOLDS,
      roomNotifyDepthBreak: 100,
      queueBacklogThreshold: 5000,
    };
    const fired = evaluateAlerts(
      baseInputs({
        queues: [
          mapQueueGauge(
            { key: 'notify', name: 'worker:room-notify' },
            { waiting: 200 }, // < 5000 generic, > 100 depth-break
            false,
            null,
            1000,
          ),
        ],
      }),
      tighter,
    );
    expect(ruleOf(fired, TGR_ALERT_RULES.QUEUE_BACKLOG)?.value).toContain(
      'notify',
    );
  });
});

describe('formatMetricsLogLine (Req 2 — every key once)', () => {
  const report: TgrMetricsReport = {
    overallStatus: 'healthy',
    queues: [
      mapQueueGauge(
        { key: 'publish', name: 'worker:publish-nip29' },
        { waiting: 5 },
        false,
        900,
        1900,
      ),
      mapQueueGauge(
        { key: 'backfill', name: 'worker:room-backfill' },
        { waiting: 2 },
        false,
        null,
        1900,
      ),
      mapQueueGauge(
        { key: 'reconcile_balance', name: 'main:reconcile-balance' },
        { waiting: 0 },
        false,
        null,
        1900,
      ),
      mapQueueGauge(
        { key: 'reconcile_membership', name: 'worker:reconcile-membership' },
        { waiting: 1 },
        false,
        null,
        1900,
      ),
      mapQueueGauge(
        { key: 'notify', name: 'worker:room-notify' },
        null,
        null,
        null,
        1900,
      ),
    ],
    relay: {
      writerConnected: true,
      subscriberConnected: false,
      reconnects: 2,
      lastDisconnectAt: null,
      writerDownSeconds: 0,
    },
    relayState: { pending_add: 1, added: 2, pending_remove: 3, removed: 4 },
    roomState: { none: 5, pending: 6, created: 7, failed: 8, deleted: 9 },
    drift: { count: 4, ratio: 0.1, membershipTotal: 40 },
    reconcile: { maxAgeSeconds: 120, staleCount: 0 },
    backfill: {
      created: 7,
      total: 35,
      failed: 8,
      percent: 20,
      cursorHeight: 42,
    },
    counters: { publishOk: 11, publishFailed: 1, ackTimeouts: 0 },
    alerts: [],
    processLocal: true,
  };

  const EXPECTED_KEYS = [
    'publish_q_depth',
    'publish_q_lag_ms',
    'backfill_q_depth',
    'reconcile_balance_q_depth',
    'reconcile_membership_q_depth',
    'notify_q_depth',
    'relay_writer_connected',
    'relay_subscriber_connected',
    'relay_reconnects',
    'ms_pending_add',
    'ms_added',
    'ms_pending_remove',
    'ms_removed',
    'room_none',
    'room_pending',
    'room_created',
    'room_failed',
    'room_deleted',
    'drift_count',
    'drift_ratio',
    'reconcile_max_age_s',
    'reconcile_stale_count',
    'backfill_created',
    'backfill_total',
    'backfill_pct',
    'publish_ok',
    'publish_failed',
    'ack_timeouts',
  ];

  it('contains the [TgrMetrics] tag + every Req-2 key exactly once', () => {
    const line = formatMetricsLogLine(report);
    expect(line.startsWith('[TgrMetrics]')).toBe(true);
    for (const key of EXPECTED_KEYS) {
      const matches = line.match(new RegExp(`(?:^| )${key}=`, 'g')) ?? [];
      expect(matches.length).toBe(1);
    }
  });

  it('renders absent queue depth as n/a + values from the report', () => {
    const line = formatMetricsLogLine(report);
    expect(line).toContain('publish_q_depth=5');
    expect(line).toContain('publish_q_lag_ms=1000');
    expect(line).toContain('notify_q_depth=n/a');
    expect(line).toContain('ms_pending_add=1');
    expect(line).toContain('room_created=7');
    expect(line).toContain('drift_count=4');
    expect(line).toContain('backfill_pct=20');
  });
});

describe('formatAlertLogLine', () => {
  it('renders rule=/value=/threshold=/severity=', () => {
    const line = formatAlertLogLine({
      rule: TGR_ALERT_RULES.DRIFT_RATIO,
      severity: 'warning',
      value: 0.1,
      threshold: 0.02,
    });
    expect(line).toBe(
      '[TgrAlert] rule=drift_ratio value=0.1 threshold=0.02 severity=warning',
    );
  });
});

import { TgrMetricsController } from '../tgr-metrics.controller';
import type { TgrMetricsReport } from '../tgr-metrics.collector';

describe('TgrMetricsController', () => {
  function report(over: Partial<TgrMetricsReport> = {}): TgrMetricsReport {
    return {
      overallStatus: 'healthy',
      queues: [],
      relay: {
        writerConnected: false,
        subscriberConnected: false,
        reconnects: 0,
        lastDisconnectAt: null,
        writerDownSeconds: 0,
      },
      relayState: { pending_add: 0, added: 0, pending_remove: 0, removed: 0 },
      roomState: { none: 0, pending: 0, created: 0, failed: 0, deleted: 0 },
      drift: { count: 0, ratio: 0, membershipTotal: 0 },
      reconcile: { maxAgeSeconds: 0, staleCount: 0 },
      backfill: {
        created: 0,
        total: 0,
        failed: 0,
        percent: 0,
        cursorHeight: null,
      },
      counters: { publishOk: 0, publishFailed: 0, ackTimeouts: 0 },
      alerts: [],
      processLocal: true,
      ...over,
    };
  }

  it('serves the report from the main process with processLocal=false + slos + thresholds', async () => {
    const collect = jest.fn(async (processLocal: boolean) =>
      report({ processLocal }),
    );
    const thresholds = { driftRatio: 0.02 } as any;
    const service: any = {
      collect,
      getThresholds: () => thresholds,
    };
    const controller = new TgrMetricsController(service);

    const result = await controller.getMetrics();

    // Controller MUST request the main-served (non-authoritative) view.
    expect(collect).toHaveBeenCalledWith(false);
    expect(result.processLocal).toBe(false);
    expect(result.thresholds).toBe(thresholds);
    expect(result.slos).toMatchObject({
      roomCreatedWithinSeconds: 300,
      membershipPublishedWithinSeconds: 60,
    });
    expect(result.overallStatus).toBe('healthy');
  });

  it('propagates a critical overallStatus', async () => {
    const service: any = {
      collect: async () => report({ overallStatus: 'critical' }),
      getThresholds: () => ({}),
    };
    const controller = new TgrMetricsController(service);
    const result = await controller.getMetrics();
    expect(result.overallStatus).toBe('critical');
  });
});

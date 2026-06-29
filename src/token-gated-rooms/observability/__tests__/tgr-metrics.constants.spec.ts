import {
  resolveMetricsCron,
  TGR_METRICS_CRON_DEFAULT,
  TGR_METRICS_QUEUES,
} from '../tgr-metrics.constants';

describe('resolveMetricsCron', () => {
  it('defaults to the 1-min cron when unset/blank', () => {
    expect(resolveMetricsCron({})).toBe(TGR_METRICS_CRON_DEFAULT);
    expect(resolveMetricsCron({ TG_METRICS_CRON: '   ' })).toBe(
      TGR_METRICS_CRON_DEFAULT,
    );
  });

  it('accepts a 5- or 6-field crontab', () => {
    expect(resolveMetricsCron({ TG_METRICS_CRON: '*/5 * * * *' })).toBe(
      '*/5 * * * *',
    );
    expect(resolveMetricsCron({ TG_METRICS_CRON: '0 */1 * * * *' })).toBe(
      '0 */1 * * * *',
    );
  });

  it('falls back on a malformed expression', () => {
    expect(resolveMetricsCron({ TG_METRICS_CRON: 'every-minute' })).toBe(
      TGR_METRICS_CRON_DEFAULT,
    );
  });
});

describe('TGR_METRICS_QUEUES', () => {
  it('lists the five canonical TGR queues with prefixed names', () => {
    const byKey = Object.fromEntries(TGR_METRICS_QUEUES.map((q) => [q.key, q]));
    expect(byKey.publish.name).toBe('worker:publish-nip29');
    expect(byKey.backfill.name).toBe('worker:room-backfill');
    expect(byKey.reconcile_balance.name).toBe('main:reconcile-balance');
    expect(byKey.reconcile_membership.name).toBe('worker:reconcile-membership');
    expect(byKey.notify.name).toBe('worker:room-notify');
  });
});

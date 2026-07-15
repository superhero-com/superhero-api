import {
  cappedBackoffStrategy,
  publishNip29JobOptions,
  TGR_CAPPED_BACKOFF,
} from '../publish-nip29.job-options';

describe('publishNip29JobOptions', () => {
  it('sets attempts = maxRetries + 1 and the capped backoff strategy', () => {
    const opts = publishNip29JobOptions(5);
    expect(opts.attempts).toBe(6);
    expect(opts.backoff).toEqual({ type: TGR_CAPPED_BACKOFF });
    expect(opts.removeOnComplete).toBe(true);
    // Failed publishes are cleaned (not retained forever) to avoid unbounded
    // Redis growth on the highest-volume queue; failures are surfaced via the
    // `tgr.publish.ack(ok:false)` seam + ERROR logs, so the raw jobs add no value.
    expect(opts.removeOnFail).toBe(true);
  });

  it('floors attempts at 1 for zero retries', () => {
    expect(publishNip29JobOptions(0).attempts).toBe(1);
  });
});

describe('cappedBackoffStrategy', () => {
  it('matches capped-exponential across attempts and clamps at 300000ms', () => {
    expect(cappedBackoffStrategy(1)).toBe(1000);
    expect(cappedBackoffStrategy(2)).toBe(2000);
    expect(cappedBackoffStrategy(3)).toBe(4000);
    expect(cappedBackoffStrategy(20)).toBe(300000);
  });
});

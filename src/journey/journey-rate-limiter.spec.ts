import { JourneyRateLimiter } from './journey-rate-limiter';
import { JOURNEY_LIMITS } from './journey.constants';

const PER_CLIENT = JOURNEY_LIMITS.MAX_EVENTS_PER_CLIENT_PER_MINUTE;
const GLOBAL = JOURNEY_LIMITS.MAX_EVENTS_PER_MINUTE;
const T0 = 1_700_000_000_000;

describe('JourneyRateLimiter', () => {
  let limiter: JourneyRateLimiter;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    limiter = new JourneyRateLimiter();
    warn = jest
      .spyOn((limiter as any).logger, 'warn')
      .mockImplementation(() => undefined);
  });

  it('keeps everything below the per-client cap', () => {
    expect(limiter.take('1.1.1.1', 50, T0)).toBe(50);
    expect(limiter.take('1.1.1.1', 50, T0 + 1)).toBe(50);
  });

  it('cuts the request that crosses the per-client cap and refuses the rest of the minute', () => {
    expect(limiter.take('1.1.1.1', PER_CLIENT - 3, T0)).toBe(PER_CLIENT - 3);
    expect(limiter.take('1.1.1.1', 50, T0 + 1)).toBe(3);
    expect(limiter.take('1.1.1.1', 50, T0 + 59_999)).toBe(0);
  });

  it('counts each client separately', () => {
    expect(limiter.take('1.1.1.1', PER_CLIENT + 10, T0)).toBe(PER_CLIENT);
    expect(limiter.take('2.2.2.2', 50, T0)).toBe(50);
  });

  it('caps the total across clients', () => {
    let kept = 0;
    for (let i = 0; i * PER_CLIENT < GLOBAL; i++) {
      kept += limiter.take(`10.0.0.${i}`, PER_CLIENT, T0);
    }
    expect(kept).toBe(GLOBAL);
    expect(limiter.take('2.2.2.2', 50, T0)).toBe(0);
  });

  it('does not track a client it refuses entirely', () => {
    for (let i = 0; i * PER_CLIENT < GLOBAL; i++) {
      limiter.take(`10.0.0.${i}`, PER_CLIENT, T0);
    }
    const tracked = (limiter as any).perClient.size;
    for (let i = 0; i < 100; i++) {
      limiter.take(`192.0.2.${i}`, 1, T0);
    }
    expect((limiter as any).perClient.size).toBe(tracked);
  });

  it('starts a fresh allowance once the minute is over', () => {
    limiter.take('1.1.1.1', PER_CLIENT, T0);
    expect(limiter.take('1.1.1.1', 50, T0 + 60_000)).toBe(50);
  });

  it('logs the drops of the previous minute once, without any client address', () => {
    limiter.take('203.0.113.7', PER_CLIENT + 30, T0);
    limiter.take('203.0.113.7', 20, T0 + 1);
    expect(warn).not.toHaveBeenCalled();

    limiter.take('203.0.113.7', 1, T0 + 60_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('50 events');
    expect(String(warn.mock.calls[0][0])).toContain(
      `accepted ${PER_CLIENT} of ${GLOBAL}`,
    );
    expect(String(warn.mock.calls[0][0])).not.toContain('203.0.113.7');

    limiter.take('203.0.113.7', 1, T0 + 120_000);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

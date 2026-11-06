import { JourneyRateLimiter } from './journey-rate-limiter';
import { JOURNEY_LIMITS } from './journey.constants';

const PER_CLIENT = JOURNEY_LIMITS.MAX_EVENTS_PER_CLIENT_PER_MINUTE;
const GLOBAL = JOURNEY_LIMITS.MAX_EVENTS_PER_MINUTE;
const DAILY = JOURNEY_LIMITS.MAX_EVENTS_PER_DAY;
const T0 = 1_700_000_000_000;
const MIDNIGHT = Date.UTC(2026, 10, 3);

describe('JourneyRateLimiter', () => {
  let limiter: JourneyRateLimiter;
  let error: jest.SpyInstance;

  beforeEach(() => {
    limiter = new JourneyRateLimiter();
    error = jest
      .spyOn((limiter as any).logger, 'error')
      .mockImplementation(() => undefined);
  });

  /** Fills one minute up to the global cap; returns how many were kept. */
  const fillMinute = (now: number): number => {
    let kept = 0;
    for (let i = 0; i * PER_CLIENT < GLOBAL; i++) {
      kept += limiter.take(`10.0.0.${i}`, PER_CLIENT, now);
    }
    return kept;
  };
  const fillDay = (dayStart: number): number => {
    let kept = 0;
    for (let minute = 0; minute < Math.ceil(DAILY / GLOBAL); minute++) {
      kept += fillMinute(dayStart + minute * 60_000);
    }
    return kept;
  };

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

  it('caps the total per UTC day, even in a fresh minute', () => {
    expect(fillDay(MIDNIGHT)).toBe(DAILY);
    const later = MIDNIGHT + 23 * 60 * 60 * 1000;
    expect(limiter.take('2.2.2.2', 50, later)).toBe(0);
  });

  it('starts a fresh daily allowance at UTC midnight', () => {
    fillDay(MIDNIGHT);
    const nextMidnight = MIDNIGHT + 24 * 60 * 60 * 1000;
    expect(limiter.take('2.2.2.2', 50, nextMidnight - 1)).toBe(0);
    expect(limiter.take('2.2.2.2', 50, nextMidnight)).toBe(50);
  });

  it('never lets one client use up the daily cap on its own', () => {
    const lastMinute = MIDNIGHT + 1439 * 60_000;
    for (let t = MIDNIGHT; t <= lastMinute; t += 60_000) {
      limiter.take('203.0.113.7', PER_CLIENT, t);
    }
    expect(limiter.take('2.2.2.2', 50, lastMinute + 1)).toBe(50);
  });

  it('logs the drops of the previous minute once, without any client address', () => {
    limiter.take('203.0.113.7', PER_CLIENT + 30, T0);
    limiter.take('203.0.113.7', 20, T0 + 1);
    expect(error).not.toHaveBeenCalled();

    limiter.take('203.0.113.7', 1, T0 + 60_000);
    expect(error).toHaveBeenCalledTimes(1);
    const message = String(error.mock.calls[0][0]);
    expect(message).toContain('50 events');
    expect(message).toContain(`accepted ${PER_CLIENT} of ${GLOBAL}`);
    expect(message).toContain(`${PER_CLIENT} of ${DAILY} in the UTC day`);
    expect(message).not.toContain('203.0.113.7');

    limiter.take('203.0.113.7', 1, T0 + 120_000);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

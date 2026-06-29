import { GroupMissingTracker } from '../group-missing-tracker.service';

describe('GroupMissingTracker', () => {
  let tracker: GroupMissingTracker;

  beforeEach(() => {
    tracker = new GroupMissingTracker();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('is not missing by default', () => {
    expect(tracker.isMissing('ct_a')).toBe(false);
    expect(tracker.size).toBe(0);
  });

  it('marks a group missing and clears it', () => {
    tracker.markMissing('ct_a');
    expect(tracker.isMissing('ct_a')).toBe(true);
    expect(tracker.size).toBe(1);

    tracker.clear('ct_a');
    expect(tracker.isMissing('ct_a')).toBe(false);
    expect(tracker.size).toBe(0);
  });

  it('debounces: marking is idempotent per sale', () => {
    tracker.markMissing('ct_a');
    tracker.markMissing('ct_a');
    expect(tracker.size).toBe(1);
  });

  it('expires entries after the TTL (and lazily evicts on read)', () => {
    jest.useFakeTimers();
    tracker.markMissing('ct_a', 1000);
    expect(tracker.isMissing('ct_a')).toBe(true);

    jest.advanceTimersByTime(1001);
    expect(tracker.isMissing('ct_a')).toBe(false); // expired
    expect(tracker.size).toBe(0); // lazily evicted by the isMissing read
  });
});

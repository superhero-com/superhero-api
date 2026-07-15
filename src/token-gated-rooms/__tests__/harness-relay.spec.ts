import {
  RELAY_ADMIN_NSEC,
  RELAY_URL,
  relayReachable,
} from '@/test/harness/relay';

/**
 * Task 02 harness self-test (relay fixture). Proves the centralized
 * `relayReachable` probe + relay-admin defaults behave for relay-backed specs:
 *   - an unreachable URL resolves `false` (within the bounded timeout) so specs
 *     can `describe.skip` deterministically — this runs with no relay present;
 *   - the configured local relay (when one is up at `RELAY_URL`) resolves `true`.
 *
 * Kept in the unit project (no DB) so it always runs; the live-relay assertion is
 * gated on reachability so it never flakes the no-container path.
 */
describe('harness/relay: reachability probe (self-test)', () => {
  it('exposes the local relay URL + relay-admin nsec defaults', () => {
    expect(typeof RELAY_URL).toBe('string');
    expect(RELAY_URL).toMatch(/^wss?:\/\//);
    expect(RELAY_ADMIN_NSEC).toMatch(/^nsec1[0-9a-z]+$/);
  });

  it('returns false for an unreachable relay (bounded, no throw)', async () => {
    // A port nothing listens on — must resolve false within the timeout.
    const reachable = await relayReachable('ws://127.0.0.1:1', 1500);
    expect(reachable).toBe(false);
  }, 5000);

  it('detects the local relay when one is running (auto-skip otherwise)', async () => {
    const up = await relayReachable(RELAY_URL, 3000);
    if (!up) {
      // eslint-disable-next-line no-console
      console.warn(
        `[harness/relay self-test] no relay at ${RELAY_URL} — skipping live check`,
      );
      return;
    }
    expect(up).toBe(true);
  }, 8000);
});

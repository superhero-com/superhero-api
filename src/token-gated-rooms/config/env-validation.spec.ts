import { isRelayConfigured, RELAY_ENV } from './env-validation';

// Worker mode removed (deworker-plan.md): there is no longer a throwing
// `validateTgrEnv`. The relay-actuator duties self-enable iff a relay is
// configured; `env-validation` now just re-exports the `isRelayConfigured`
// predicate + the list of relay-enabling env vars.
describe('relay-config env', () => {
  it('RELAY_ENV lists the two relay-enabling vars', () => {
    expect(RELAY_ENV).toEqual(['TG_RELAY_URL', 'TG_BOT_NSEC']);
  });

  it('isRelayConfigured is true only when both vars are present (non-blank)', () => {
    expect(
      isRelayConfigured({
        TG_RELAY_URL: 'ws://relay',
        TG_BOT_NSEC: 'nsec1abc',
      }),
    ).toBe(true);
    expect(isRelayConfigured({ TG_RELAY_URL: 'ws://relay' })).toBe(false);
    expect(isRelayConfigured({ TG_BOT_NSEC: 'nsec1abc' })).toBe(false);
    expect(isRelayConfigured({ TG_RELAY_URL: '  ', TG_BOT_NSEC: '' })).toBe(
      false,
    );
    expect(isRelayConfigured({})).toBe(false);
  });
});

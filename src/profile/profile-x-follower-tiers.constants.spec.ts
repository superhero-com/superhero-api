describe('PROFILE_X_FOLLOWER_TIERS parsing', () => {
  const ORIGINAL = process.env.PROFILE_X_FOLLOWER_TIERS;

  const loadTiers = (value: string | undefined) => {
    jest.resetModules();
    if (value === undefined) {
      delete process.env.PROFILE_X_FOLLOWER_TIERS;
    } else {
      process.env.PROFILE_X_FOLLOWER_TIERS = value;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('./profile.constants').PROFILE_X_FOLLOWER_TIERS;
  };

  afterAll(() => {
    if (ORIGINAL === undefined) {
      delete process.env.PROFILE_X_FOLLOWER_TIERS;
    } else {
      process.env.PROFILE_X_FOLLOWER_TIERS = ORIGINAL;
    }
    jest.resetModules();
  });

  it('parses a valid tier table sorted ascending with stable indexes', () => {
    const tiers = loadTiers('10000:1,0:0.1,1000:0.5');
    expect(tiers).toEqual([
      { minFollowers: 0, amountAe: '0.1', index: 0 },
      { minFollowers: 1000, amountAe: '0.5', index: 1 },
      { minFollowers: 10000, amountAe: '1', index: 2 },
    ]);
  });

  it('drops invalid entries (bad number, non-positive amount, negatives)', () => {
    const tiers = loadTiers('0:0.1,abc:1,1000:0,-5:2,2000:0.3');
    expect(tiers).toEqual([
      { minFollowers: 0, amountAe: '0.1', index: 0 },
      { minFollowers: 2000, amountAe: '0.3', index: 1 },
    ]);
  });

  it('falls back to defaults when unset', () => {
    const tiers = loadTiers(undefined);
    expect(Array.isArray(tiers)).toBe(true);
    expect(tiers.length).toBeGreaterThan(0);
    // The default table starts at the advertised 100-follower floor, not 0.
    // profile.constants.spec.ts pins the exact amounts against the rewards
    // page; this only checks the parse produced the configured default.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PROFILE_X_FOLLOWER_TIERS_DEFAULT } = require('./profile.constants');
    expect(tiers[0].minFollowers).toBe(
      Number(PROFILE_X_FOLLOWER_TIERS_DEFAULT.split(':')[0]),
    );
  });

  it('falls back to the default table when every entry is invalid', () => {
    // This used to assert `[]`, which encoded the silent failure as correct.
    // An empty table makes resolveFollowerTier return null for every follower
    // count, so a single typo in the env var stopped all per-post rewards with
    // nothing logged and every endpoint looking healthy. Now it complains and
    // uses the advertised table.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const tiers = loadTiers('foo,bar:,:1,5');
    expect(tiers.length).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

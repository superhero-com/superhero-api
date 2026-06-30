describe('PROFILE_X_FOLLOWER_TIERS parsing', () => {
  const ORIGINAL = process.env.PROFILE_X_FOLLOWER_TIERS;

  const loadTiers = (value: string | undefined) => {
    jest.resetModules();
    if (value === undefined) {
      delete process.env.PROFILE_X_FOLLOWER_TIERS;
    } else {
      process.env.PROFILE_X_FOLLOWER_TIERS = value;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
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
    expect(tiers[0].minFollowers).toBe(0);
  });

  it('yields an empty list when every entry is invalid', () => {
    const tiers = loadTiers('foo,bar:,:1,5');
    expect(tiers).toEqual([]);
  });
});

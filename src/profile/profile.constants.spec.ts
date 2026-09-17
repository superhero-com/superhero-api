/**
 * The reward defaults must equal what the rewards page advertises.
 *
 * This file exists because the two drifted and nothing noticed: the page
 * promised 50 AE for milestone 1 while the code's default was 0.05, and
 * promised 10/20/30 per post while the default table started at 0 followers
 * paying 0.1. An environment that armed the program without setting every
 * amount paid the wrong number, correctly, forever.
 *
 * Constants are read at module load, so each case re-imports in isolation with
 * the environment it is testing.
 */
describe('X reward defaults', () => {
  const ENV_KEYS = [
    'PROFILE_X_ONBOARDING_REWARD_AMOUNT_AE',
    'PROFILE_X_POSTING_REWARD_AMOUNT_AE',
    'PROFILE_X_FOLLOWER_TIERS',
    'PROFILE_X_REWARD_STREAK_BONUS_AMOUNT_AE',
    'PROFILE_X_REWARD_STREAK_LENGTH',
    'PROFILE_X_REWARD_MIN_FOLLOWERS',
    'PROFILE_REWARDS_DISABLED',
    'PROFILE_X_ONBOARDING_REWARD_ENABLED',
    'PROFILE_X_PERPOST_REWARD_ENABLED',
    'PROFILE_X_REWARD_STREAK_BONUS_ENABLED',
  ];

  const load = (env: Record<string, string | undefined> = {}) => {
    let mod: typeof import('./profile.constants');
    jest.isolateModules(() => {
      const saved = new Map<string, string | undefined>();
      for (const key of ENV_KEYS) {
        saved.set(key, process.env[key]);
        delete process.env[key];
      }
      Object.entries(env).forEach(([k, v]) => {
        if (v !== undefined) process.env[k] = v;
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require('./profile.constants');
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    return mod!;
  };

  describe('amounts match the advertised program', () => {
    it('pays 50 AE for linking X and one post', () => {
      // Milestone 1, "Earn 50 AE". Was 0.05 by way of the posting-reward
      // fallback — a thousandth of the promise, paid silently.
      expect(load().PROFILE_X_ONBOARDING_REWARD_AMOUNT_AE).toBe('50');
    });

    it('uses the 10 / 20 / 30 per-post tiers, starting at 100 followers', () => {
      const tiers = load().PROFILE_X_FOLLOWER_TIERS;
      expect(tiers.map((t) => [t.minFollowers, t.amountAe] as const)).toEqual([
        [100, '10'],
        [10000, '20'],
        [1000000, '30'],
      ]);
      // Below the advertised floor nothing matches, which is what makes
      // "under 100 followers: not eligible" true in the tier table too.
      expect(tiers[0].minFollowers).toBeGreaterThan(0);
    });

    it('keeps the streak bonus at 50 AE over 10 days', () => {
      const c = load();
      expect(c.PROFILE_X_REWARD_STREAK_BONUS_AMOUNT_AE).toBe('50');
      expect(c.PROFILE_X_REWARD_STREAK_LENGTH).toBe(10);
    });

    it('requires the advertised 100 followers', () => {
      expect(load().PROFILE_X_REWARD_MIN_FOLLOWERS).toBe(100);
    });
  });

  describe('safety switches still fail closed', () => {
    it('leaves every payout disabled until explicitly armed', () => {
      // Deliberately NOT changed alongside the amounts. A switch that defaults
      // wrong means nothing happens, which is safe and obvious; an amount that
      // defaults wrong means the wrong amount is really paid. Defaulting these
      // to on would arm real spending on any box that merely forgot to say no.
      const c = load();
      expect(c.PROFILE_REWARDS_DISABLED).toBe(true);
      expect(c.PROFILE_X_ONBOARDING_REWARD_ENABLED).toBe(false);
      expect(c.PROFILE_X_PERPOST_REWARD_ENABLED).toBe(false);
      expect(c.PROFILE_X_REWARD_STREAK_BONUS_ENABLED).toBe(false);
    });

    it('keeps the master switch overriding an armed program', () => {
      const c = load({
        PROFILE_X_ONBOARDING_REWARD_ENABLED: 'true',
        PROFILE_REWARDS_DISABLED: 'true',
      });
      expect(c.PROFILE_X_ONBOARDING_REWARD_ENABLED).toBe(false);
    });
  });

  describe('overrides', () => {
    it('lets an explicit onboarding amount win', () => {
      expect(
        load({ PROFILE_X_ONBOARDING_REWARD_AMOUNT_AE: '7' })
          .PROFILE_X_ONBOARDING_REWARD_AMOUNT_AE,
      ).toBe('7');
    });

    it('still honours a deployment that set only the posting amount', () => {
      // Someone relying on the old fallback keeps the number they chose;
      // only the final default moved.
      expect(
        load({ PROFILE_X_POSTING_REWARD_AMOUNT_AE: '3' })
          .PROFILE_X_ONBOARDING_REWARD_AMOUNT_AE,
      ).toBe('3');
    });

    it('lets a valid tier override win over the advertised table', () => {
      const tiers = load({
        PROFILE_X_FOLLOWER_TIERS: '50:1,500:2',
      }).PROFILE_X_FOLLOWER_TIERS;
      expect(tiers.map((t) => t.amountAe)).toEqual(['1', '2']);
    });

    // Parsing mechanics, including the fallback when an override yields no
    // usable entry, live in profile-x-follower-tiers.constants.spec.ts.
  });
});

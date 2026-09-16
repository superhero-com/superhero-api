/* eslint-disable @typescript-eslint/no-require-imports */
export {};
// The readiness preflight is decided from module-level constants AND the X app
// credentials in `@/configs/social`, so each case is re-required under an
// isolated mock of both (require, not import, so the doMock takes effect).
const ADDRESS = 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo';

// A valid 32-byte seed (parses) used as the onboarding payout key when armed.
const VALID_KEY = '1'.repeat(64);

const ARMED_CONSTANTS = {
  PROFILE_REWARDS_DISABLED: false,
  PROFILE_X_POSTING_REWARD_ENABLED: true,
  PROFILE_X_POSTING_REWARD_ENABLE_POST_FETCH: true,
  PROFILE_X_ONBOARDING_REWARD_ENABLED: true,
  PROFILE_X_ONBOARDING_REWARD_AMOUNT_AE: '0.05',
  PROFILE_X_ONBOARDING_REWARD_PRIVATE_KEY: VALID_KEY,
  PROFILE_X_ONBOARDING_THRESHOLD: 1,
  PROFILE_X_POSTING_REWARD_KEYWORDS: ['superhero.com'],
  PROFILE_X_REWARD_MIN_FOLLOWERS: 100,
  PROFILE_X_REWARD_STREAK_LENGTH: 10,
  PROFILE_X_FOLLOWER_TIERS: [],
  PROFILE_X_REFERRAL_LINK_BASE_URL: 'https://superhero.com',
  PROFILE_X_REWARD_DAILY_CAP_HOURS: 24,
  isInformationalXError: (code: string | null | undefined) =>
    code === 'x_posts_scan_truncated',
};

const CREDS_PRESENT = {
  X_API_KEY: 'app_key',
  X_API_KEY_SECRET: 'app_secret',
  X_CLIENT_ID: 'app_key',
  X_CLIENT_SECRET: 'app_secret',
};

const CREDS_ABSENT = {
  X_API_KEY: '',
  X_API_KEY_SECRET: '',
  X_CLIENT_ID: '',
  X_CLIENT_SECRET: '',
};

type BuildResult = {
  service: any;
  rows: Map<string, any>;
  spend: jest.Mock;
  enqueueSpend: jest.Mock;
  fetchSpy: jest.Mock;
};

const build = async (
  constantsOverride: Record<string, unknown>,
  socialOverride: Record<string, string>,
  seedRow?: Record<string, unknown>,
): Promise<BuildResult> => {
  let out: BuildResult;
  await jest.isolateModulesAsync(async () => {
    jest.doMock('../profile.constants', () => ({
      ...ARMED_CONSTANTS,
      ...constantsOverride,
    }));
    jest.doMock('@/configs/social', () => socialOverride);
    const {
      ProfileXPostingRewardService,
    } = require('./profile-x-posting-reward.service');
    const {
      ProfileXApiClientService,
    } = require('./profile-x-api-client.service');

    const rows = new Map<string, any>();
    if (seedRow) {
      rows.set(ADDRESS, { status: 'pending', ...seedRow });
    }
    const postingRewardRepository: any = {
      findOne: jest.fn(async () => rows.get(ADDRESS) ?? null),
      save: jest.fn(async (v: any) => {
        rows.set(v.address, { ...rows.get(v.address), ...v });
        return rows.get(v.address);
      }),
      update: jest.fn(),
      create: jest.fn(),
      find: jest.fn(),
    };
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;
    const spend = jest.fn();
    const enqueueSpend = jest.fn();
    const service = new ProfileXPostingRewardService(
      postingRewardRepository,
      { findOne: jest.fn().mockResolvedValue(null) } as any,
      {} as any,
      { sdk: { spend } } as any,
      { enqueueSpend, getRewardAccount: jest.fn() } as any,
      new ProfileXApiClientService(),
      { find: jest.fn(), update: jest.fn() } as any,
      { find: jest.fn(), update: jest.fn() } as any,
      { record: jest.fn().mockResolvedValue(undefined) } as any,
    );
    out = { service, rows, spend, enqueueSpend, fetchSpy };
  });
  return out!;
};

describe('ProfileXPostingRewardService readiness contract', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('reports program_status=active with the onboarding contract when fully armed', async () => {
    const { service } = await build(ARMED_CONSTANTS, CREDS_PRESENT);
    await expect(service.getRewardStatus(ADDRESS)).resolves.toMatchObject({
      program_status: 'active',
      error_code: null,
      onboarding_enabled: true,
      onboarding_amount_ae: '0.05',
      onboarding_keywords: ['superhero.com'],
    });
  });

  it('reports program_status=unavailable when armed but X credentials are absent', async () => {
    const { service } = await build(ARMED_CONSTANTS, CREDS_ABSENT);
    await expect(service.getRewardStatus(ADDRESS)).resolves.toMatchObject({
      program_status: 'unavailable',
      error_code: 'rewards_unavailable',
      // Amount is only surfaced when active.
      onboarding_amount_ae: null,
    });
  });

  it('reports program_status=unavailable when armed but the onboarding payout key is absent', async () => {
    const { service } = await build(
      { PROFILE_X_ONBOARDING_REWARD_PRIVATE_KEY: '' },
      CREDS_PRESENT,
    );
    await expect(service.getRewardStatus(ADDRESS)).resolves.toMatchObject({
      program_status: 'unavailable',
      error_code: 'rewards_unavailable',
    });
  });

  it('recheck returns 503 BEFORE any slot/strike/X call when unavailable (no credentials)', async () => {
    const { service, rows, spend, enqueueSpend, fetchSpy } = await build(
      ARMED_CONSTANTS,
      CREDS_ABSENT,
      { address: ADDRESS, x_username: 'poster', x_lookup_failure_count: 2 },
    );

    await expect(service.requestManualRecheck(ADDRESS)).rejects.toMatchObject({
      status: 503,
      response: { error_code: 'rewards_unavailable' },
    });

    // No X call, no spend, and the strike counter is untouched.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(enqueueSpend).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
    expect(rows.get(ADDRESS)?.x_lookup_failure_count).toBe(2);
    // The slot was never claimed (still absent).
    expect(rows.get(ADDRESS)?.last_x_api_scan_at).toBeUndefined();
  });
});

/* eslint-disable @typescript-eslint/no-var-requires */
// Each gate needs a different module-level constants config (KEYWORDS empty vs
// post-fetch disabled), so the service is re-required under an isolated mock per
// case (require, not import, so the doMock takes effect). These gates
// short-circuit BEFORE any paid X API call.
const ADDRESS = 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo';

const BASE_CONSTANTS = {
  PROFILE_X_POSTING_REWARD_ENABLED: true,
  PROFILE_X_POSTING_REWARD_ENABLE_POST_FETCH: true,
  PROFILE_X_POSTING_REWARD_FETCH_TIMEOUT_MS: 5000,
  PROFILE_X_POSTING_REWARD_KEYWORDS: ['superhero.com'],
  PROFILE_X_POSTING_REWARD_RETRY_BASE_SECONDS: 1,
  PROFILE_X_POSTING_REWARD_RETRY_MAX_SECONDS: 60,
  PROFILE_X_REWARD_MIN_FOLLOWERS: 100,
  PROFILE_X_FOLLOWER_TIERS: [],
};

const runGate = async (constantsOverride: Record<string, unknown>) => {
  let result: any;
  await jest.isolateModulesAsync(async () => {
    jest.doMock('../profile.constants', () => ({
      ...BASE_CONSTANTS,
      ...constantsOverride,
    }));
    jest.doMock('@/configs/social', () => ({
      X_API_KEY: 'k',
      X_API_KEY_SECRET: 's',
      X_CLIENT_ID: 'k',
      X_CLIENT_SECRET: 's',
    }));
    const {
      ProfileXPostingRewardService,
    } = require('./profile-x-posting-reward.service');
    const {
      ProfileXApiClientService,
    } = require('./profile-x-api-client.service');

    const row: any = { address: ADDRESS, x_username: 'poster' };
    const postingRewardRepository: any = {
      findOne: jest.fn(async () => row),
      save: jest.fn(async (v: any) => Object.assign(row, v)),
      update: jest.fn(),
      create: jest.fn(),
      find: jest.fn(),
    };
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;
    const service = new ProfileXPostingRewardService(
      postingRewardRepository,
      { findOne: jest.fn() } as any,
      {} as any,
      { sdk: { spend: jest.fn() } } as any,
      { enqueueSpend: jest.fn(), getRewardAccount: jest.fn() } as any,
      new ProfileXApiClientService(),
      { find: jest.fn(), update: jest.fn() } as any,
      { find: jest.fn(), update: jest.fn() } as any,
    );

    await (service as any).processAddressInternal(ADDRESS);
    result = { row, fetchSpy };
  });
  return result;
};

describe('ProfileXPostingRewardService scan gates', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('marks missing_keywords and makes no X call when no keywords are configured', async () => {
    const { row, fetchSpy } = await runGate({
      PROFILE_X_POSTING_REWARD_KEYWORDS: [],
    });
    expect(row.error).toBe('missing_keywords');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('marks post_fetch_disabled and makes no X call when post fetch is off', async () => {
    const { row, fetchSpy } = await runGate({
      PROFILE_X_POSTING_REWARD_ENABLE_POST_FETCH: false,
    });
    expect(row.error).toBe('post_fetch_disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

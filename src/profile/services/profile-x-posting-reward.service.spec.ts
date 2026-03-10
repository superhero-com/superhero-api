jest.mock('../profile.constants', () => ({
  PROFILE_X_POSTING_REWARD_AMOUNT_AE: '0.05',
  PROFILE_X_POSTING_REWARD_ENABLED: true,
  PROFILE_X_POSTING_REWARD_ENABLE_PERIODIC_RECHECKS: false,
  PROFILE_X_POSTING_REWARD_FETCH_TIMEOUT_MS: 5000,
  PROFILE_X_POSTING_REWARD_KEYWORDS: ['superhero.com', 'superhero_chain'],
  PROFILE_X_POSTING_REWARD_MANUAL_RECHECK_COOLDOWN_SECONDS: 3600,
  PROFILE_X_POSTING_REWARD_RETRY_BASE_SECONDS: 1,
  PROFILE_X_POSTING_REWARD_RETRY_MAX_SECONDS: 60,
  PROFILE_X_POSTING_REWARD_SCAN_INTERVAL_SECONDS: 300,
  PROFILE_X_POSTING_REWARD_THRESHOLD: 10,
  PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY:
    '1111111111111111111111111111111111111111111111111111111111111111',
}));

import { ProfileXPostingReward } from '../entities/profile-x-posting-reward.entity';
import { ProfileXPostingRewardService } from './profile-x-posting-reward.service';

describe('ProfileXPostingRewardService', () => {
  const ADDRESS = 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo';
  const OTHER_ADDRESS = 'ak_2A9A8vXrX3tQzN5xW1TfFjBgfDkJtN2gQq7mB7cDgY7xT2R9s';
  const originalFetch = global.fetch;
  let userIdByUsername: Record<string, string>;
  let tweetsByUserId: Record<
    string,
    Array<{
      id: string;
      text: string;
      created_at?: string;
      entities?: {
        urls?: Array<{
          expanded_url?: string;
          display_url?: string;
          unwound_url?: string;
          url?: string;
        }>;
      };
    }>
  >;

  type RewardRow = Partial<ProfileXPostingReward> & { address: string };

  beforeEach(() => {
    userIdByUsername = {
      poster: '100',
      conflict: '200',
    };
    tweetsByUserId = {
      '100': [],
      '200': [],
    };
    global.fetch = jest.fn().mockImplementation(async (input: string) => {
      const url = new URL(input);
      if (
        url.pathname === '/2/oauth2/token' ||
        url.pathname === '/oauth2/token'
      ) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'x_app_token', expires_in: 3600 }),
        } as any;
      }
      if (url.pathname.startsWith('/2/users/by/username/')) {
        const username = decodeURIComponent(url.pathname.split('/').pop() || '');
        const id = userIdByUsername[username];
        if (!id) {
          return {
            ok: false,
            status: 404,
            json: async () => ({ detail: 'Not found' }),
          } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id, username } }),
        } as any;
      }
      if (url.pathname.startsWith('/2/users/') && url.pathname.endsWith('/tweets')) {
        const userId = url.pathname.split('/')[3] || '';
        const sinceId = url.searchParams.get('since_id');
        const startTime = url.searchParams.get('start_time');
        const pageToken = url.searchParams.get('pagination_token');
        const maxResults = Number(url.searchParams.get('max_results') || '100');
        const startIndex = Number(pageToken || '0');
        const filteredTweets = (tweetsByUserId[userId] || []).filter((tweet) => {
          if (!sinceId) {
            if (!startTime) {
              return true;
            }
            return !!tweet.created_at &&
              new Date(tweet.created_at).getTime() >= new Date(startTime).getTime();
          }
          try {
            return BigInt(tweet.id) > BigInt(sinceId);
          } catch {
            return tweet.id > sinceId;
          }
        });
        const tweets = filteredTweets.slice(startIndex, startIndex + maxResults);
        const newest = filteredTweets.reduce<string | null>((current, tweet) => {
          if (!current) {
            return tweet.id;
          }
          try {
            return BigInt(tweet.id) > BigInt(current) ? tweet.id : current;
          } catch {
            return tweet.id > current ? tweet.id : current;
          }
        }, null);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: tweets,
            meta:
              newest
                ? {
                    newest_id: newest,
                    ...(startIndex + maxResults < filteredTweets.length
                      ? { next_token: String(startIndex + maxResults) }
                      : {}),
                  }
                : {},
          }),
        } as any;
      }
      throw new Error(`Unexpected fetch URL in test: ${input}`);
    }) as any;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  const extractFindOperatorValue = (value: any) => value?._value ?? value?.value;
  const extractFindOperatorType = (value: any) => value?._type ?? value?.type;

  const createRowsStore = (seed?: RewardRow[]) => {
    const rows = new Map<string, RewardRow>();
    for (const row of seed || []) {
      rows.set(row.address, {
        retry_count: 0,
        qualified_posts_count: 0,
        status: 'pending',
        ...row,
      });
    }
    return rows;
  };

  const matchesWhere = (row: RewardRow, where: any): boolean => {
    return Object.entries(where || {}).every(([key, rawValue]) => {
      const value = rawValue as any;
      const operatorType = extractFindOperatorType(value);
      if (operatorType === 'in') {
        return extractFindOperatorValue(value).includes((row as any)[key]);
      }
      if (operatorType === 'isNull') {
        return (row as any)[key] === null || (row as any)[key] === undefined;
      }
      if (operatorType === 'not') {
        return (row as any)[key] !== extractFindOperatorValue(value);
      }
      return (row as any)[key] === value;
    });
  };

  const getService = (overrides?: {
    rows?: Map<string, RewardRow>;
    aeSdkService?: any;
    profileSpendQueueService?: any;
    profileCacheRow?: any;
    verificationRewardRow?: any;
    updateImpl?: (criteria: any, partial: any, rows: Map<string, RewardRow>) => any;
  }) => {
    const rows = overrides?.rows || createRowsStore();
    const postingRewardRepository = {
      findOne: jest.fn().mockImplementation(async ({ where }) => {
        const wheres = Array.isArray(where) ? where : [where];
        for (const currentWhere of wheres) {
          const match = Array.from(rows.values()).find((row) =>
            matchesWhere(row, currentWhere),
          );
          if (match) {
            return match;
          }
        }
        return null;
      }),
      find: jest.fn().mockImplementation(async () => {
        const now = Date.now();
        return Array.from(rows.values()).filter((row) => {
          if (row.status !== 'pending' && row.status !== 'failed') {
            return false;
          }
          if (!row.next_retry_at) {
            return true;
          }
          return new Date(row.next_retry_at).getTime() <= now;
        });
      }),
      create: jest.fn().mockImplementation((value) => ({
        retry_count: 0,
        qualified_posts_count: 0,
        status: 'pending',
        ...value,
      })),
      save: jest.fn().mockImplementation(async (value) => {
        rows.set(value.address, {
          ...rows.get(value.address),
          ...value,
        });
        return rows.get(value.address);
      }),
      update: jest.fn().mockImplementation(async (criteria, partial) => {
        if (overrides?.updateImpl) {
          return overrides.updateImpl(criteria, partial, rows);
        }
        let affected = 0;
        for (const row of rows.values()) {
          if (!matchesWhere(row, criteria)) {
            continue;
          }
          rows.set(row.address, {
            ...row,
            ...partial,
          });
          affected += 1;
        }
        return { affected };
      }),
    } as any;

    const aeSdkService =
      overrides?.aeSdkService ||
      ({
        sdk: {
          spend: jest.fn().mockResolvedValue({ hash: 'th_posting_reward_1' }),
        },
      } as any);
    const profileSpendQueueService =
      overrides?.profileSpendQueueService ||
      ({
        enqueueSpend: jest.fn().mockImplementation(async (_k, work) => work()),
        getRewardAccount: jest.fn().mockReturnValue({}),
      } as any);
    const profileCacheRepository = {
      findOne: jest.fn().mockResolvedValue(overrides?.profileCacheRow || null),
    } as any;
    const verificationRewardRepository = {
      findOne: jest.fn().mockResolvedValue(overrides?.verificationRewardRow || null),
    } as any;
    const dataSource = {} as any;

    const service = new ProfileXPostingRewardService(
      postingRewardRepository,
      profileCacheRepository,
      verificationRewardRepository,
      dataSource,
      aeSdkService,
      profileSpendQueueService,
    );
    return {
      service,
      rows,
      aeSdkService,
      postingRewardRepository,
      profileCacheRepository,
      verificationRewardRepository,
    };
  };

  it('keeps reward status reads side-effect free', async () => {
    const { service, rows, profileCacheRepository } = getService({
      profileCacheRow: { address: ADDRESS, x_username: 'poster' },
    });

    const result = await service.getRewardStatus(ADDRESS);

    expect(result.status).toBe('not_started');
    expect(rows.size).toBe(0);
    expect(profileCacheRepository.findOne).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('requires a currently linked x profile for manual recheck', async () => {
    const { service } = getService({
      verificationRewardRow: { address: ADDRESS, x_username: 'poster' },
    });

    await expect(service.requestManualRecheck(ADDRESS)).rejects.toThrow(
      'X profile is not linked for this address yet',
    );
  });

  it('bootstraps manual recheck from the current linked x profile', async () => {
    const verifiedAtMs = Date.now() - 10_000;
    const after = new Date(verifiedAtMs + 1000).toISOString();
    tweetsByUserId['100'] = Array.from({ length: 10 }, (_, index) => ({
      id: String(1001 + index),
      text: `superhero.com post ${index}`,
      created_at: after,
    }));
    const { service, rows } = getService({
      profileCacheRow: {
        address: ADDRESS,
        x_username: 'poster',
        last_seen_micro_time: String(BigInt(verifiedAtMs) * 1000n),
      },
    });

    const result = await service.requestManualRecheck(ADDRESS);

    expect(result.status).toBe('paid');
    expect(rows.get(ADDRESS)?.x_username).toBe('poster');
  });

  it('uses stored x_user_id on manual recheck without username lookup', async () => {
    const rows = createRowsStore([
      {
        address: ADDRESS,
        x_username: 'poster',
        x_user_id: '100',
        qualified_posts_count: 9,
        last_scanned_tweet_id: '1001',
        status: 'pending',
      },
    ]);
    tweetsByUserId['100'] = [{ id: '1002', text: 'Check superhero.com now' }];
    const { service } = getService({
      rows,
      profileCacheRow: { address: ADDRESS, x_username: 'poster' },
    });

    await service.requestManualRecheck(ADDRESS);

    const fetchCalls = (global.fetch as jest.Mock).mock.calls.map(([input]) =>
      String(input),
    );
    expect(
      fetchCalls.some((url) => url.includes('/2/users/by/username/poster')),
    ).toBe(false);
  });

  it('does not treat scheduler next_retry_at as manual cooldown', async () => {
    const rows = createRowsStore([
      {
        address: ADDRESS,
        x_username: 'poster',
        x_user_id: '100',
        qualified_posts_count: 9,
        last_scanned_tweet_id: '1001',
        next_retry_at: new Date(Date.now() + 60_000),
        status: 'pending',
      },
    ]);
    tweetsByUserId['100'] = [{ id: '1002', text: 'superhero.com now' }];
    const { service, aeSdkService } = getService({
      rows,
      profileCacheRow: { address: ADDRESS, x_username: 'poster' },
    });

    await service.requestManualRecheck(ADDRESS);

    expect(aeSdkService.sdk.spend).toHaveBeenCalledTimes(1);
  });

  it('enforces manual cooldown independently of row retry state', async () => {
    const rows = createRowsStore([
      {
        address: ADDRESS,
        x_username: 'poster',
        x_user_id: '100',
        qualified_posts_count: 0,
        last_scanned_tweet_id: '1000',
        status: 'pending',
      },
    ]);
    const { service } = getService({
      rows,
      profileCacheRow: { address: ADDRESS, x_username: 'poster' },
    });

    await service.requestManualRecheck(ADDRESS);
    await expect(service.requestManualRecheck(ADDRESS)).rejects.toMatchObject({
      status: 429,
    });
  });

  it('sanitizes conflict status and does not leak wallet addresses', async () => {
    const rows = createRowsStore([
      {
        address: ADDRESS,
        x_username: 'poster',
        x_user_id: '100',
        status: 'blocked_x_identity_conflict',
        error: 'x_identity_already_rewarded',
      },
    ]);
    const { service } = getService({ rows });

    const result = await service.getRewardStatus(ADDRESS);

    expect(result.status).toBe('failed');
    expect(result.error).toBe(
      'This X account is already being used for another reward.',
    );
    expect(result.error).not.toContain('ak_');
  });

  it('deduplicates reward processing by source transaction hash', async () => {
    const { service } = getService();

    await service.upsertVerifiedCandidateFromTx(ADDRESS, 'poster', undefined, 'th_1');
    await service.upsertVerifiedCandidateFromTx(ADDRESS, 'poster', undefined, 'th_1');

    const usernameLookups = (global.fetch as jest.Mock).mock.calls.filter(
      ([input]) => String(input).includes('/2/users/by/username/poster'),
    );
    expect(usernameLookups).toHaveLength(1);
  });

  it('keeps payout in a finalizing state after post-spend db failure and avoids duplicate spend', async () => {
    const rows = createRowsStore([
      {
        address: ADDRESS,
        x_username: 'poster',
        x_user_id: '100',
        qualified_posts_count: 10,
        last_scanned_tweet_id: '1001',
        status: 'pending',
      },
    ]);
    const aeSdkService = {
      sdk: {
        spend: jest.fn().mockResolvedValue({ hash: 'th_posting_reward_1' }),
      },
    } as any;
    const updateImpl = jest.fn().mockImplementation(async (criteria, partial, map) => {
      for (const row of map.values()) {
        if (!matchesWhere(row, criteria)) {
          continue;
        }
        if (partial.status === 'paid') {
          throw new Error('db write failed');
        }
        map.set(row.address, {
          ...row,
          ...partial,
        });
        return { affected: 1 };
      }
      return { affected: 0 };
    });

    const first = getService({
      rows,
      aeSdkService,
      profileCacheRow: { address: ADDRESS, x_username: 'poster' },
      updateImpl,
    });

    const firstResult = await first.service.requestManualRecheck(ADDRESS);
    expect(firstResult.error).toBe('Reward payout is being finalized.');
    expect(aeSdkService.sdk.spend).toHaveBeenCalledTimes(1);

    const second = getService({
      rows,
      aeSdkService,
      profileCacheRow: { address: ADDRESS, x_username: 'poster' },
      updateImpl,
    });
    const secondResult = await second.service.requestManualRecheck(ADDRESS);
    expect(secondResult.error).toBe('Reward payout is being finalized.');
    expect(aeSdkService.sdk.spend).toHaveBeenCalledTimes(1);
  });

  it('advances the scan cursor when pagination is truncated', async () => {
    const rows = createRowsStore([
      {
        address: ADDRESS,
        x_username: 'poster',
        x_user_id: '100',
        qualified_posts_count: 0,
        last_scanned_tweet_id: '1000',
        status: 'pending',
      },
    ]);
    tweetsByUserId['100'] = Array.from({ length: 2100 }, (_, index) => ({
      id: String(1001 + index),
      text: `noise ${index}`,
    }));
    const { service, rows: stateRows } = getService({
      rows,
      profileCacheRow: { address: ADDRESS, x_username: 'poster' },
    });

    const result = await service.requestManualRecheck(ADDRESS);

    expect(stateRows.get(ADDRESS)?.last_scanned_tweet_id).toBe('3000');
    expect(result.status).toBe('pending');
    expect(result.error).toBe(
      'A portion of your posts was scanned. Recheck later for the rest.',
    );
  });

  it('skips cron processing when periodic rescans are disabled', async () => {
    const rows = createRowsStore([
      {
        address: ADDRESS,
        x_username: 'poster',
        x_user_id: '100',
        status: 'pending',
      },
    ]);
    const { service, postingRewardRepository, aeSdkService } = getService({ rows });

    await service.processDueRewards();

    expect(postingRewardRepository.find).not.toHaveBeenCalled();
    expect(aeSdkService.sdk.spend).not.toHaveBeenCalled();
  });
});

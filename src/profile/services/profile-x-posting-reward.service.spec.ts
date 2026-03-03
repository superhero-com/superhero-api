jest.mock('../profile.constants', () => ({
  PROFILE_X_POSTING_REWARD_AMOUNT_AE: '0.05',
  PROFILE_X_POSTING_REWARD_FETCH_TIMEOUT_MS: 5000,
  PROFILE_X_POSTING_REWARD_KEYWORDS: ['superhero.com', 'superhero_chain'],
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
      retryer: '300',
    };
    tweetsByUserId = {
      '100': [],
      '200': [],
      '300': [],
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
        const username = url.pathname.split('/').pop() || '';
        const id = userIdByUsername[decodeURIComponent(username)];
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
            if (!tweet.created_at) {
              return false;
            }
            return new Date(tweet.created_at).getTime() >= new Date(startTime).getTime();
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

  const getService = (overrides?: {
    rows?: Map<string, RewardRow>;
    aeSdkService?: any;
    profileSpendQueueService?: any;
  }) => {
    const rows = overrides?.rows || createRowsStore();
    const postingRewardRepository = {
      findOne: jest.fn().mockImplementation(async ({ where }) => {
        if (where?.address) {
          return rows.get(where.address) || null;
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
    } as any;
    const managerRepo = {
      createQueryBuilder: jest.fn().mockImplementation(() => {
        const state: { address?: string } = {};
        return {
          setLock: jest.fn().mockReturnThis(),
          where: jest.fn().mockImplementation((_query: string, params: any) => {
            state.address = params.address;
            return {
              getOne: jest.fn().mockResolvedValue(
                state.address ? rows.get(state.address) || null : null,
              ),
            };
          }),
        };
      }),
      findOne: jest.fn().mockImplementation(async ({ where }) => {
        const firstWhere = Array.isArray(where) ? where[0] : where;
        const secondWhere = Array.isArray(where) ? where[1] : where;
        const statuses = firstWhere?.status
          ? extractFindOperatorValue(firstWhere.status)
          : [];
        const excludedAddress = extractFindOperatorValue(firstWhere?.address);
        for (const row of rows.values()) {
          if (row.address === excludedAddress) {
            continue;
          }
          if (!statuses.includes(row.status)) {
            continue;
          }
          if (
            (firstWhere?.x_user_id && row.x_user_id === firstWhere.x_user_id) ||
            (secondWhere?.x_username && row.x_username === secondWhere.x_username)
          ) {
            return row;
          }
        }
        return null;
      }),
      save: jest.fn().mockImplementation(async (value) => {
        rows.set(value.address, {
          ...rows.get(value.address),
          ...value,
        });
        return rows.get(value.address);
      }),
    } as any;
    const dataSource = {
      transaction: jest
        .fn()
        .mockImplementation(async (work: (manager: any) => Promise<any>) =>
          work({
            getRepository: jest.fn().mockReturnValue(managerRepo),
          }),
        ),
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
      findOne: jest.fn().mockResolvedValue(null),
    } as any;
    const verificationRewardRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    } as any;

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
    };
  };

  it('creates baseline from current tweets without counting old posts', async () => {
    tweetsByUserId['100'] = [
      { id: '1000', text: 'superhero.com old mention' },
      { id: '1001', text: 'superhero_chain old mention' },
    ];
    const { service, rows, aeSdkService } = getService();

    await service.upsertVerifiedCandidate(
      'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
      'poster',
    );

    const row = rows.get('ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo');
    expect(aeSdkService.sdk.spend).not.toHaveBeenCalled();
    expect(row?.qualified_posts_count).toBe(0);
    expect(row?.last_scanned_tweet_id ?? null).toBeNull();
  });

  it('counts only posts created after verification on first scan', async () => {
    const verifiedAtMs = Date.now() - 10_000;
    const before = new Date(verifiedAtMs - 1000).toISOString();
    const after = new Date(verifiedAtMs + 1000).toISOString();
    tweetsByUserId['100'] = [
      { id: '1000', text: 'superhero.com old mention', created_at: before },
      { id: '1001', text: 'superhero_chain new mention', created_at: after },
    ];
    const { service, rows, aeSdkService } = getService();

    await service.upsertVerifiedCandidate(
      'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
      'poster',
      String(BigInt(verifiedAtMs) * 1000n),
    );

    const row = rows.get('ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo');
    expect(aeSdkService.sdk.spend).not.toHaveBeenCalled();
    expect(row?.qualified_posts_count).toBe(1);
    expect(row?.last_scanned_tweet_id).toBe('1001');
  });

  it('counts across paginated X responses without missing posts', async () => {
    const rows = createRowsStore([
      {
        address: 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
        x_username: 'poster',
        x_user_id: '100',
        qualified_posts_count: 0,
        last_scanned_tweet_id: '1000',
        status: 'pending',
      },
    ]);
    tweetsByUserId['100'] = Array.from({ length: 150 }, (_, index) => ({
      id: String(1001 + index),
      text: `post ${index} with superhero.com`,
    }));
    const { service, rows: stateRows, aeSdkService } = getService({ rows });

    await service.processDueRewards();

    const row = stateRows.get('ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo');
    expect(aeSdkService.sdk.spend).toHaveBeenCalledTimes(1);
    expect(row?.status).toBe('paid');
    expect(row?.qualified_posts_count).toBe(150);
    expect(row?.last_scanned_tweet_id).toBe('1150');
  });

  it('pays once threshold is reached with new qualifying posts', async () => {
    const rows = createRowsStore([
      {
        address: 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
        x_username: 'poster',
        x_user_id: '100',
        qualified_posts_count: 9,
        last_scanned_tweet_id: '1001',
        status: 'pending',
      },
    ]);
    tweetsByUserId['100'] = [{ id: '1002', text: 'Check superhero.com now' }];
    const { service, aeSdkService } = getService({ rows });

    await service.processDueRewards();

    const row = rows.get('ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo');
    expect(aeSdkService.sdk.spend).toHaveBeenCalledTimes(1);
    expect(row?.status).toBe('paid');
    expect(row?.qualified_posts_count).toBe(10);
  });

  it('counts superhero.com from expanded URL entities', async () => {
    const rows = createRowsStore([
      {
        address: 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
        x_username: 'poster',
        x_user_id: '100',
        qualified_posts_count: 9,
        last_scanned_tweet_id: '1001',
        status: 'pending',
      },
    ]);
    tweetsByUserId['100'] = [
      {
        id: '1002',
        text: 'Check this out https://t.co/abc',
        entities: {
          urls: [
            {
              expanded_url: 'https://superhero.com/some-page',
            },
          ],
        },
      },
    ];
    const { service, aeSdkService } = getService({ rows });

    await service.processDueRewards();

    const row = rows.get('ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo');
    expect(aeSdkService.sdk.spend).toHaveBeenCalledTimes(1);
    expect(row?.status).toBe('paid');
    expect(row?.qualified_posts_count).toBe(10);
  });

  it('retries after spend failure and pays later', async () => {
    const rows = createRowsStore([
      {
        address: 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
        x_username: 'retryer',
        x_user_id: '300',
        qualified_posts_count: 10,
        last_scanned_tweet_id: '5000',
        status: 'pending',
      },
    ]);
    const aeSdkService = {
      sdk: {
        spend: jest
          .fn()
          .mockRejectedValueOnce(new Error('insufficient balance'))
          .mockResolvedValueOnce({ hash: 'th_posting_reward_2' }),
      },
    } as any;
    const { service } = getService({ rows, aeSdkService });

    await service.processDueRewards();
    let row = rows.get('ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo');
    expect(row?.status).toBe('pending');
    expect(row?.retry_count).toBe(1);
    expect(row?.next_retry_at).toBeTruthy();

    rows.set('ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo', {
      ...row!,
      next_retry_at: new Date(Date.now() - 1000),
    });
    await service.processDueRewards();
    row = rows.get('ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo');
    expect(aeSdkService.sdk.spend).toHaveBeenCalledTimes(2);
    expect(row?.status).toBe('paid');
  });

  it('marks conflict when same x identity already paid elsewhere', async () => {
    const rows = createRowsStore([
      {
        address: 'ak_first',
        x_username: 'conflict',
        x_user_id: '200',
        status: 'paid',
      },
    ]);
    const { service, aeSdkService } = getService({ rows });

    await service.upsertVerifiedCandidate(
      'ak_second',
      'conflict',
    );

    const row = rows.get('ak_second');
    expect(aeSdkService.sdk.spend).not.toHaveBeenCalled();
    expect(row?.status).toBe('blocked_x_identity_conflict');
    expect(row?.next_retry_at).toBeNull();
  });

  it('retries when x post fetch fails', async () => {
    (global.fetch as jest.Mock).mockImplementation(async (input: string) => {
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
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: '100', username: 'poster' } }),
        } as any;
      }
      throw new Error('x timeline unavailable');
    });

    const rows = createRowsStore([
      {
        address: 'ak_retry',
        x_username: 'poster',
        last_scanned_tweet_id: '1000',
        status: 'pending',
      },
    ]);
    const { service, aeSdkService } = getService({ rows });

    await service.processDueRewards();
    const row = rows.get('ak_retry');
    expect(aeSdkService.sdk.spend).not.toHaveBeenCalled();
    expect(row?.status).toBe('pending');
    expect(row?.retry_count).toBe(1);
    expect(row?.next_retry_at).toBeTruthy();
  });
});

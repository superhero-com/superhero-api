jest.mock('@/configs/social', () => ({
  X_API_KEY: 'app_key',
  X_API_KEY_SECRET: 'app_secret',
  X_CLIENT_ID: 'app_key',
  X_CLIENT_SECRET: 'app_secret',
}));

jest.mock('../profile.constants', () => ({
  PROFILE_X_POSTING_REWARD_ENABLED: true,
  PROFILE_X_POSTING_REWARD_ENABLE_POST_FETCH: true,
  PROFILE_X_POSTING_REWARD_FETCH_TIMEOUT_MS: 5000,
  PROFILE_X_POSTING_REWARD_KEYWORDS: ['superhero.com', 'superhero_chain'],
  PROFILE_X_POSTING_REWARD_RETRY_BASE_SECONDS: 1,
  PROFILE_X_POSTING_REWARD_RETRY_MAX_SECONDS: 60,
  PROFILE_X_REFERRAL_LINK_BASE_URL: 'https://superhero.com/r',
  PROFILE_X_REWARD_DAILY_CAP_HOURS: 24,
  PROFILE_X_REWARD_MIN_FOLLOWERS: 50,
  PROFILE_X_ONBOARDING_REWARD_ENABLED: true,
  PROFILE_X_ONBOARDING_REWARD_AMOUNT_AE: '1',
  PROFILE_X_ONBOARDING_REWARD_PRIVATE_KEY: '1'.repeat(64),
  PROFILE_X_ONBOARDING_THRESHOLD: 1,
  PROFILE_X_PERPOST_REWARD_ENABLED: true,
  PROFILE_X_PERPOST_REWARD_PRIVATE_KEY: '1'.repeat(64),
  PROFILE_X_REWARD_STREAK_BONUS_ENABLED: true,
  PROFILE_X_REWARD_STREAK_BONUS_AMOUNT_AE: '50',
  PROFILE_X_REWARD_STREAK_BONUS_PRIVATE_KEY: '1'.repeat(64),
  PROFILE_X_REWARD_STREAK_LENGTH: 3,
  PROFILE_X_FOLLOWER_TIERS: [
    { minFollowers: 0, amountAe: '0.1', index: 0 },
    { minFollowers: 1000, amountAe: '0.5', index: 1 },
  ],
}));

import { ProfileXPostingReward } from '../entities/profile-x-posting-reward.entity';
import { ProfileXApiClientService } from './profile-x-api-client.service';
import { ProfileXPostingRewardService } from './profile-x-posting-reward.service';

type RewardRow = Partial<ProfileXPostingReward> & { address: string };

const ADDRESS = 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo';
const ONBOARDING_AETTOS = '1000000000000000000'; // 1 AE
const PER_POST_AETTOS = '100000000000000000'; // 0.1 AE
const STREAK_BONUS_AETTOS = '50000000000000000000'; // 50 AE

const opType = (v: any) => v?._type ?? v?.type;
const opValue = (v: any) => v?._value ?? v?.value;

const matchesWhere = (row: any, where: any): boolean =>
  Object.entries(where || {}).every(([key, raw]) => {
    const type = opType(raw);
    if (type === 'in') {
      return opValue(raw).includes(row[key]);
    }
    if (type === 'isNull') {
      return row[key] === null || row[key] === undefined;
    }
    if (type === 'not') {
      return row[key] !== opValue(raw);
    }
    if (type === 'lessThanOrEqual') {
      if (row[key] === null || row[key] === undefined) {
        return false;
      }
      return new Date(row[key]).getTime() <= new Date(opValue(raw)).getTime();
    }
    return row[key] === (raw as any);
  });

const matchesAnyWhere = (row: any, where: any): boolean => {
  const wheres = Array.isArray(where) ? where : [where];
  return wheres.some((w) => matchesWhere(row, w));
};

describe('ProfileXPostingRewardService (rewards v2)', () => {
  const originalFetch = global.fetch;

  let followersByUserId: Record<string, number>;
  let userIdByUsername: Record<string, string>;
  let tweetsByUserId: Record<
    string,
    Array<{
      id: string;
      text: string;
      created_at?: string;
      entities?: { urls?: Array<{ expanded_url?: string }> };
    }>
  >;

  beforeEach(() => {
    userIdByUsername = { poster: '100' };
    followersByUserId = { '100': 500 };
    tweetsByUserId = { '100': [] };
    global.fetch = jest.fn().mockImplementation(async (input: string) => {
      const url = new URL(input);
      const path = url.pathname;
      if (path === '/oauth2/token' || path === '/2/oauth2/token') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'tok', expires_in: 3600 }),
        } as any;
      }
      if (path.startsWith('/2/users/by/username/')) {
        const username = decodeURIComponent(path.split('/').pop() || '');
        const id = userIdByUsername[username];
        if (!id) {
          return { ok: false, status: 404, json: async () => ({}) } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              id,
              username,
              public_metrics: { followers_count: followersByUserId[id] ?? 0 },
            },
          }),
        } as any;
      }
      if (path.startsWith('/2/users/') && path.endsWith('/tweets')) {
        const userId = path.split('/')[3] || '';
        const sinceId = url.searchParams.get('since_id');
        const startTime = url.searchParams.get('start_time');
        const all = tweetsByUserId[userId] || [];
        const filtered = all.filter((t) => {
          if (sinceId) {
            try {
              return BigInt(t.id) > BigInt(sinceId);
            } catch {
              return t.id > sinceId;
            }
          }
          if (startTime) {
            return (
              !!t.created_at &&
              new Date(t.created_at).getTime() >= new Date(startTime).getTime()
            );
          }
          return true;
        });
        const newest = filtered.reduce<string | null>((cur, t) => {
          if (!cur) return t.id;
          try {
            return BigInt(t.id) > BigInt(cur) ? t.id : cur;
          } catch {
            return t.id > cur ? t.id : cur;
          }
        }, null);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: filtered,
            meta: newest ? { newest_id: newest } : {},
          }),
        } as any;
      }
      // by-id profile lookup: /2/users/:id
      if (path.startsWith('/2/users/')) {
        const id = path.split('/')[3] || '';
        const username =
          Object.entries(userIdByUsername).find(([, v]) => v === id)?.[0] || '';
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              id,
              username,
              public_metrics: { followers_count: followersByUserId[id] ?? 0 },
            },
          }),
        } as any;
      }
      throw new Error(`Unexpected fetch in test: ${input}`);
    }) as any;
  });

  afterEach(() => jest.clearAllMocks());
  afterAll(() => {
    global.fetch = originalFetch;
  });

  const xReadCallCount = () =>
    (global.fetch as jest.Mock).mock.calls.filter(([input]: [string]) =>
      new URL(input).pathname.startsWith('/2/users/'),
    ).length;

  const resetScanWindow = (rows: Map<string, RewardRow>) => {
    rows.set(ADDRESS, {
      ...rows.get(ADDRESS)!,
      last_x_api_scan_at: new Date(Date.now() - 48 * 3600 * 1000),
    });
  };

  const makeService = (opts?: { rows?: RewardRow[]; account?: any }) => {
    const rows = new Map<string, RewardRow>();
    for (const r of opts?.rows || []) {
      rows.set(r.address, {
        retry_count: 0,
        qualified_posts_count: 0,
        current_streak_days: 0,
        x_lookup_failure_count: 0,
        status: 'pending',
        ...r,
      });
    }
    const ledger: any[] = [];
    let ledgerSeq = 0;
    const bonusRows: any[] = [];
    let bonusSeq = 0;

    const postingRewardRepository: any = {
      findOne: jest.fn(async ({ where }: any) => {
        for (const row of rows.values()) {
          if (matchesAnyWhere(row, where)) return row;
        }
        return null;
      }),
      create: jest.fn((v: any) => ({
        retry_count: 0,
        qualified_posts_count: 0,
        current_streak_days: 0,
        x_lookup_failure_count: 0,
        status: 'pending',
        ...v,
      })),
      save: jest.fn(async (v: any) => {
        rows.set(v.address, { ...rows.get(v.address), ...v });
        return rows.get(v.address);
      }),
      update: jest.fn(async (criteria: any, partial: any) => {
        let affected = 0;
        for (const row of rows.values()) {
          if (!matchesWhere(row, criteria)) continue;
          rows.set(row.address, { ...row, ...partial });
          affected += 1;
        }
        return { affected };
      }),
      createQueryBuilder: jest.fn(() => {
        const state: any = { set: {}, params: {} };
        const qb: any = {
          update: () => qb,
          set: (v: any) => {
            state.set = v;
            return qb;
          },
          where: (_s: string, p: any) => {
            Object.assign(state.params, p);
            return qb;
          },
          andWhere: (_s: string, p: any) => {
            Object.assign(state.params, p);
            return qb;
          },
          execute: async () => {
            const row = rows.get(state.params.address);
            if (!row) return { affected: 0 };
            const last = row.last_x_api_scan_at
              ? new Date(row.last_x_api_scan_at)
              : null;
            const eligible =
              !last ||
              last.getTime() <= new Date(state.params.cutoff).getTime();
            if (!eligible) return { affected: 0 };
            rows.set(row.address, { ...row, ...state.set });
            return { affected: 1 };
          },
        };
        return qb;
      }),
    };

    const postRewardLedgerRepository: any = {
      find: jest.fn(async ({ where }: any) =>
        ledger.filter((row) => matchesAnyWhere(row, where)),
      ),
      count: jest.fn(
        async ({ where }: any) =>
          ledger.filter((row) => matchesWhere(row, where)).length,
      ),
      update: jest.fn(async (criteria: any, partial: any) => {
        let affected = 0;
        for (let i = 0; i < ledger.length; i += 1) {
          if (!matchesWhere(ledger[i], criteria)) continue;
          ledger[i] = { ...ledger[i], ...partial };
          affected += 1;
        }
        return { affected };
      }),
      createQueryBuilder: jest.fn(() => {
        const state: any = { params: {} };
        const qb: any = {
          insert: () => qb,
          into: () => qb,
          values: (v: any) => {
            state.values = v;
            return qb;
          },
          orIgnore: () => qb,
          select: () => qb,
          addSelect: () => qb,
          where: (_s: string, p: any) => {
            Object.assign(state.params, p);
            return qb;
          },
          andWhere: (_s: string, p: any) => {
            if (p) Object.assign(state.params, p);
            return qb;
          },
          // getPerPostTotals aggregate over the in-memory ledger.
          getRawOne: async () => {
            const address = state.params.address;
            const matched = ledger.filter(
              (r) =>
                r.address === address &&
                r.status === 'paid' &&
                /^[0-9]+$/.test(String(r.amount_aettos ?? '')),
            );
            let sum = BigInt(0);
            for (const r of matched) sum += BigInt(r.amount_aettos);
            return { count: String(matched.length), aettos: sum.toString() };
          },
          execute: async () => {
            const v = state.values;
            // Mirror both unique constraints: per-tweet identity AND the
            // one-rewarded-post-per-day cap.
            const exists = ledger.find(
              (r) =>
                (r.x_user_id === v.x_user_id && r.tweet_id === v.tweet_id) ||
                (v.tweet_utc_day != null &&
                  r.x_user_id === v.x_user_id &&
                  r.tweet_utc_day === v.tweet_utc_day),
            );
            if (exists) return { identifiers: [] };
            ledgerSeq += 1;
            ledger.push({
              id: String(ledgerSeq),
              retry_count: 0,
              next_retry_at: null,
              tx_hash: null,
              error: null,
              ...v,
            });
            return { identifiers: [{ id: String(ledgerSeq) }] };
          },
        };
        return qb;
      }),
    };

    const insertBonusRows = (values: any) => {
      for (const v of Array.isArray(values) ? values : [values]) {
        const exists = bonusRows.find(
          (r) =>
            r.x_user_id === v.x_user_id &&
            r.streak_completed_day === v.streak_completed_day,
        );
        if (exists) continue;
        bonusSeq += 1;
        bonusRows.push({
          id: bonusSeq,
          retry_count: 0,
          next_retry_at: null,
          tx_hash: null,
          error: null,
          ...v,
        });
      }
    };

    const streakBonusRewardRepository: any = {
      find: jest.fn(async ({ where }: any) =>
        bonusRows.filter((row) => matchesAnyWhere(row, where)),
      ),
      count: jest.fn(
        async ({ where }: any) =>
          bonusRows.filter((row) => matchesWhere(row, where)).length,
      ),
      update: jest.fn(async (criteria: any, partial: any) => {
        let affected = 0;
        for (let i = 0; i < bonusRows.length; i += 1) {
          if (!matchesWhere(bonusRows[i], criteria)) continue;
          bonusRows[i] = { ...bonusRows[i], ...partial };
          affected += 1;
        }
        return { affected };
      }),
    };

    const dataSource: any = {
      transaction: jest.fn(async (cb: any) =>
        cb({
          getRepository: (entity: any) => {
            if (entity === ProfileXPostingReward) {
              return { save: postingRewardRepository.save };
            }
            return {
              createQueryBuilder: () => {
                const state: any = {};
                const qb: any = {
                  insert: () => qb,
                  into: () => qb,
                  values: (v: any) => {
                    state.values = v;
                    return qb;
                  },
                  orIgnore: () => qb,
                  execute: async () => {
                    insertBonusRows(state.values);
                    return { identifiers: [] };
                  },
                };
                return qb;
              },
            };
          },
        }),
      ),
    };

    const spend = jest.fn().mockImplementation(async (amount: string) => ({
      hash: `th_${amount}`,
    }));
    const aeSdkService: any = { sdk: { spend } };
    const profileSpendQueueService: any = {
      enqueueSpend: jest.fn(async (_k: string, work: any) => work()),
      getRewardAccount: jest.fn(() => ({})),
    };
    const accountRepository: any = {
      findOne: jest.fn(async () => opts?.account ?? null),
    };

    const service = new ProfileXPostingRewardService(
      postingRewardRepository,
      accountRepository,
      dataSource,
      aeSdkService,
      profileSpendQueueService,
      new ProfileXApiClientService(),
      postRewardLedgerRepository,
      streakBonusRewardRepository,
    );

    return {
      service,
      rows,
      ledger,
      bonusRows,
      spend,
      postingRewardRepository,
      postRewardLedgerRepository,
      streakBonusRewardRepository,
    };
  };

  const baseRow = (overrides?: Partial<RewardRow>): RewardRow => ({
    address: ADDRESS,
    x_username: 'poster',
    referral_code: 'codetest0001',
    verified_at: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  });

  const refUrl = (code = 'codetest0001') => ({
    expanded_url: `https://superhero.com/r?ref=${code}`,
  });

  it('atomically consumes one daily scan slot per window', async () => {
    const { service, rows } = makeService({
      rows: [{ address: ADDRESS, last_x_api_scan_at: null }],
    });

    const first = await (service as any).claimDailyScanSlot(ADDRESS);
    const second = await (service as any).claimDailyScanSlot(ADDRESS);
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(rows.get(ADDRESS)?.last_x_api_scan_at).toBeInstanceOf(Date);

    // Move the last scan outside the window → eligible again.
    resetScanWindow(rows);
    expect(await (service as any).claimDailyScanSlot(ADDRESS)).toBe(true);
  });

  it('pays the onboarding reward once for a post containing ANY single keyword', async () => {
    tweetsByUserId['100'] = [
      {
        id: '1001',
        text: 'gm from superhero.com only',
        created_at: '2026-06-01T00:00:00Z',
      },
    ];
    const { service, rows, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });

    const result = await service.requestManualRecheck(ADDRESS);

    expect(result.onboarding_status).toBe('paid');
    expect(rows.get(ADDRESS)?.status).toBe('paid');
    expect(spend).toHaveBeenCalledTimes(1);
    expect(spend.mock.calls[0][0]).toBe(ONBOARDING_AETTOS);
  });

  it('does NOT count a post without any keyword or referral link', async () => {
    tweetsByUserId['100'] = [
      {
        id: '1002',
        text: 'gm frens, nothing to see here',
        created_at: '2026-06-01T00:00:00Z',
      },
    ];
    const { service, rows, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });

    const result = await service.requestManualRecheck(ADDRESS);

    expect(result.onboarding_status).toBe('not_started');
    expect(result.qualified_posts_count).toBe(0);
    expect(result.remaining_to_goal).toBe(1);
    expect(rows.get(ADDRESS)?.status).toBe('pending');
    expect(spend).not.toHaveBeenCalled();
  });

  it('lets a referral-link post finalize onboarding AND earn the per-post reward', async () => {
    tweetsByUserId['100'] = [
      {
        id: '2001',
        text: 'join me',
        created_at: '2026-06-01T00:00:00Z',
        entities: { urls: [refUrl()] },
      },
    ];
    const { service, ledger, rows, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });

    const result = await service.requestManualRecheck(ADDRESS);

    // Path 1 finalized by the referral post.
    expect(result.onboarding_status).toBe('paid');
    expect(rows.get(ADDRESS)?.status).toBe('paid');
    // Path 2 paid for the same post.
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe('paid');
    expect(ledger[0].tier_index_at_post).toBe(0);
    const amounts = spend.mock.calls.map((c) => c[0]);
    expect(amounts).toEqual(
      expect.arrayContaining([ONBOARDING_AETTOS, PER_POST_AETTOS]),
    );
    expect(spend).toHaveBeenCalledTimes(2);

    // Re-scan the same tweet (reset cursor + window) → no second payout.
    rows.set(ADDRESS, {
      ...rows.get(ADDRESS)!,
      last_scanned_tweet_id: undefined,
      last_x_api_scan_at: new Date(Date.now() - 48 * 3600 * 1000),
    });
    await service.requestManualRecheck(ADDRESS);

    expect(ledger).toHaveLength(1);
    expect(spend).toHaveBeenCalledTimes(2);
  });

  it('rewards at most ONE referral post per UTC day', async () => {
    tweetsByUserId['100'] = [
      {
        id: '2101',
        text: 'a',
        created_at: '2026-06-01T08:00:00Z',
        entities: { urls: [refUrl()] },
      },
      {
        id: '2102',
        text: 'b',
        created_at: '2026-06-01T20:00:00Z',
        entities: { urls: [refUrl()] },
      },
      // No created_at → cannot be capped per day → earns nothing (fail-closed).
      {
        id: '2103',
        text: 'c',
        entities: { urls: [refUrl()] },
      },
    ];
    const { service, ledger, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });

    await service.requestManualRecheck(ADDRESS);

    expect(ledger).toHaveLength(1);
    expect(ledger[0].tweet_utc_day).toBe('2026-06-01');
    const perPostSpends = spend.mock.calls.filter(
      (c) => c[0] === PER_POST_AETTOS,
    );
    expect(perPostSpends).toHaveLength(1);
  });

  it('counts consecutive posting days, pays the streak bonus and resets the counter', async () => {
    tweetsByUserId['100'] = [
      {
        id: '3001',
        text: 'd1',
        created_at: '2026-06-01T08:00:00Z',
        entities: { urls: [refUrl()] },
      },
      {
        id: '3002',
        text: 'd2',
        created_at: '2026-06-02T08:00:00Z',
        entities: { urls: [refUrl()] },
      },
      {
        id: '3003',
        text: 'd3',
        created_at: '2026-06-03T08:00:00Z',
        entities: { urls: [refUrl()] },
      },
    ];
    const { service, rows, bonusRows, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });

    const result = await service.requestManualRecheck(ADDRESS);

    // Counter resets after the completion so the next bonus starts from zero.
    expect(rows.get(ADDRESS)?.current_streak_days).toBe(0);
    expect(bonusRows).toHaveLength(1);
    expect(bonusRows[0].status).toBe('paid');
    expect(bonusRows[0].streak_completed_day).toBe('2026-06-03');
    expect(result.streak_bonus_status).toBe('paid');
    expect(result.streak_bonus_paid_count).toBe(1);
    const amounts = spend.mock.calls.map((c) => c[0]);
    expect(amounts.filter((a) => a === STREAK_BONUS_AETTOS)).toHaveLength(1);
    // 3 per-post (one per day) + 1 onboarding + 1 streak bonus.
    expect(amounts.filter((a) => a === PER_POST_AETTOS)).toHaveLength(3);
    expect(amounts.filter((a) => a === ONBOARDING_AETTOS)).toHaveLength(1);
  });

  it('pays the streak bonus AGAIN after another full streak (recurring)', async () => {
    tweetsByUserId['100'] = [
      {
        id: '3001',
        text: 'd1',
        created_at: '2026-06-01T08:00:00Z',
        entities: { urls: [refUrl()] },
      },
      {
        id: '3002',
        text: 'd2',
        created_at: '2026-06-02T08:00:00Z',
        entities: { urls: [refUrl()] },
      },
      {
        id: '3003',
        text: 'd3',
        created_at: '2026-06-03T08:00:00Z',
        entities: { urls: [refUrl()] },
      },
    ];
    const { service, rows, bonusRows, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });

    await service.requestManualRecheck(ADDRESS);
    expect(bonusRows).toHaveLength(1);

    // Three more consecutive days → a second completion on the next scan.
    tweetsByUserId['100'].push(
      {
        id: '3004',
        text: 'd4',
        created_at: '2026-06-04T08:00:00Z',
        entities: { urls: [refUrl()] },
      },
      {
        id: '3005',
        text: 'd5',
        created_at: '2026-06-05T08:00:00Z',
        entities: { urls: [refUrl()] },
      },
      {
        id: '3006',
        text: 'd6',
        created_at: '2026-06-06T08:00:00Z',
        entities: { urls: [refUrl()] },
      },
    );
    resetScanWindow(rows);
    const result = await service.requestManualRecheck(ADDRESS);

    expect(bonusRows).toHaveLength(2);
    expect(bonusRows.map((r) => r.status)).toEqual(['paid', 'paid']);
    expect(bonusRows[1].streak_completed_day).toBe('2026-06-06');
    expect(result.streak_bonus_paid_count).toBe(2);
    expect(rows.get(ADDRESS)?.current_streak_days).toBe(0);
    const bonusSpends = spend.mock.calls.filter(
      (c) => c[0] === STREAK_BONUS_AETTOS,
    );
    expect(bonusSpends).toHaveLength(2);
  });

  it('resets the streak on a missed day and counts same-day posts once', async () => {
    tweetsByUserId['100'] = [
      {
        id: '3101',
        text: 'd1',
        created_at: '2026-06-01T08:00:00Z',
        entities: { urls: [refUrl()] },
      },
      {
        id: '3102',
        text: 'd1-again',
        created_at: '2026-06-01T20:00:00Z',
        entities: { urls: [refUrl()] },
      },
      {
        id: '3103',
        text: 'd2',
        created_at: '2026-06-02T08:00:00Z',
        entities: { urls: [refUrl()] },
      },
      // 2026-06-03 missed → streak restarts at the 06-04 post.
      {
        id: '3104',
        text: 'd4',
        created_at: '2026-06-04T08:00:00Z',
        entities: { urls: [refUrl()] },
      },
    ];
    const { service, rows, bonusRows } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });

    await service.requestManualRecheck(ADDRESS);

    expect(rows.get(ADDRESS)?.current_streak_days).toBe(1);
    expect(rows.get(ADDRESS)?.last_qualifying_post_day).toBe('2026-06-04');
    expect(bonusRows).toHaveLength(0);
  });

  it('blocks accounts below the minimum follower count without fetching posts', async () => {
    followersByUserId['100'] = 30;
    tweetsByUserId['100'] = [
      {
        id: '1003',
        text: 'superhero.com @superhero_chain',
        created_at: '2026-06-01T00:00:00Z',
        entities: { urls: [refUrl()] },
      },
    ];
    const { service, rows, ledger, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });

    const result = await service.requestManualRecheck(ADDRESS);

    expect(rows.get(ADDRESS)?.error).toBe('below_min_followers');
    expect(result.error).toContain('50 followers');
    expect(result.min_followers_required).toBe(50);
    expect(result.qualified_posts_count).toBe(0);
    expect(ledger).toHaveLength(0);
    expect(spend).not.toHaveBeenCalled();
    // Profile lookup happened, but the (paid) tweets fetch did not.
    const tweetCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([input]: [string]) => new URL(input).pathname.endsWith('/tweets'),
    );
    expect(tweetCalls).toHaveLength(0);
  });

  it('enforces the 24h cap on a second check without calling X again', async () => {
    tweetsByUserId['100'] = [
      { id: '1001', text: 'superhero.com', created_at: '2026-06-01T00:00:00Z' },
    ];
    const { service } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });

    await service.requestManualRecheck(ADDRESS);
    const callsAfterFirst = (global.fetch as jest.Mock).mock.calls.length;

    await expect(service.requestManualRecheck(ADDRESS)).rejects.toMatchObject({
      status: 429,
    });
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(callsAfterFirst);
  });

  it('stops calling X after repeated failed user lookups until the account is re-linked', async () => {
    delete userIdByUsername.poster;
    const { service, rows } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });

    for (let i = 1; i <= 5; i += 1) {
      resetScanWindow(rows);
      await service.requestManualRecheck(ADDRESS);
      expect(rows.get(ADDRESS)?.x_lookup_failure_count).toBe(i);
      expect(rows.get(ADDRESS)?.error).toBe('x_user_lookup_failed');
    }

    const readsAfterFive = xReadCallCount();
    resetScanWindow(rows);
    const result = await service.requestManualRecheck(ADDRESS);

    expect(rows.get(ADDRESS)?.error).toBe('x_user_lookup_blocked');
    expect(result.error).toContain('Re-link');
    // The blocked scan made no X read at all.
    expect(xReadCallCount()).toBe(readsAfterFive);

    // A fresh on-chain re-link resets the counter.
    await service.upsertVerifiedCandidate(ADDRESS, 'poster');
    expect(rows.get(ADDRESS)?.x_lookup_failure_count).toBe(0);
  });

  it('mints a unique referral link gated by ownership', async () => {
    const { service, rows } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
    });

    const { code, link } = await service.getOrCreateReferralLink(ADDRESS);

    expect(code).toMatch(/^[a-z0-9]{12}$/);
    expect(link).toBe(`https://superhero.com/r?ref=${code}`);
    expect(rows.get(ADDRESS)?.referral_code).toBe(code);

    // Idempotent: a second call returns the same code.
    const again = await service.getOrCreateReferralLink(ADDRESS);
    expect(again.code).toBe(code);
  });

  it('aggregates paid per-post totals in the status payload', async () => {
    tweetsByUserId['100'] = [
      {
        id: '7001',
        text: 'a',
        created_at: '2026-06-01T00:00:00Z',
        entities: { urls: [refUrl()] },
      },
      {
        id: '7002',
        text: 'b',
        created_at: '2026-06-02T00:00:00Z',
        entities: { urls: [refUrl()] },
      },
    ];
    const { service } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });

    const result = await service.requestManualRecheck(ADDRESS);

    expect(result.per_post_total_paid_count).toBe(2);
    // 2 * 0.1 AE in aettos
    expect(result.per_post_total_paid_aettos).toBe('200000000000000000');
  });

  it('keeps a per-post payout unclaimable when broadcast succeeds but the DB write fails', async () => {
    tweetsByUserId['100'] = [
      {
        id: '4001',
        text: 'join',
        created_at: '2026-06-01T00:00:00Z',
        entities: { urls: [refUrl()] },
      },
    ];
    const { service, ledger, spend, postRewardLedgerRepository } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });
    const realUpdate = postRewardLedgerRepository.update;
    postRewardLedgerRepository.update = jest.fn(
      async (criteria: any, partial: any) => {
        if (partial?.status === 'paid') {
          throw new Error('db unavailable');
        }
        return realUpdate(criteria, partial);
      },
    );

    await service.requestManualRecheck(ADDRESS);

    const perPostSpends = spend.mock.calls.filter(
      (c) => c[0] === PER_POST_AETTOS,
    );
    expect(perPostSpends).toHaveLength(1);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].error).toBe('payout_confirmation_pending');
    expect(ledger[0].status).not.toBe('paid');
    // Sentinel tx_hash preserved → row stays unclaimable, so no double-spend.
    expect(ledger[0].tx_hash).toBe('__per_post_payout_in_progress__');
  });

  it('keeps the onboarding payout unclaimable when broadcast succeeds but the DB write fails', async () => {
    tweetsByUserId['100'] = [
      {
        id: '4101',
        text: 'superhero.com and @superhero_chain',
        created_at: '2026-06-01T00:00:00Z',
      },
    ];
    const { service, rows, spend, postingRewardRepository } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });
    const realUpdate = postingRewardRepository.update;
    postingRewardRepository.update = jest.fn(
      async (criteria: any, partial: any) => {
        if (partial?.status === 'paid') {
          throw new Error('db unavailable');
        }
        return realUpdate(criteria, partial);
      },
    );

    let result = await service.requestManualRecheck(ADDRESS);

    expect(spend).toHaveBeenCalledTimes(1);
    expect(rows.get(ADDRESS)?.error).toBe('payout_confirmation_pending');
    expect(rows.get(ADDRESS)?.tx_hash).toBe(
      '__posting_reward_payout_in_progress__',
    );
    expect(result.onboarding_status).toBe('pending');

    // Recovered DB + rerun → the sentinel keeps the payout unclaimable.
    postingRewardRepository.update = realUpdate;
    resetScanWindow(rows);
    result = await service.requestManualRecheck(ADDRESS);
    expect(spend).toHaveBeenCalledTimes(1);
    expect(result.onboarding_status).toBe('pending');
  });

  it('keeps a streak bonus unclaimable when broadcast succeeds but the DB write fails', async () => {
    tweetsByUserId['100'] = [
      {
        id: '3201',
        text: 'd1',
        created_at: '2026-06-01T08:00:00Z',
        entities: { urls: [refUrl()] },
      },
      {
        id: '3202',
        text: 'd2',
        created_at: '2026-06-02T08:00:00Z',
        entities: { urls: [refUrl()] },
      },
      {
        id: '3203',
        text: 'd3',
        created_at: '2026-06-03T08:00:00Z',
        entities: { urls: [refUrl()] },
      },
    ];
    const { service, rows, bonusRows, spend, streakBonusRewardRepository } =
      makeService({
        account: { address: ADDRESS, links: { x: 'poster' } },
        rows: [baseRow()],
      });
    const realUpdate = streakBonusRewardRepository.update;
    streakBonusRewardRepository.update = jest.fn(
      async (criteria: any, partial: any) => {
        if (partial?.status === 'paid') {
          throw new Error('db unavailable');
        }
        return realUpdate(criteria, partial);
      },
    );

    await service.requestManualRecheck(ADDRESS);

    expect(bonusRows).toHaveLength(1);
    expect(bonusRows[0].error).toBe('payout_confirmation_pending');
    expect(bonusRows[0].status).not.toBe('paid');
    expect(bonusRows[0].tx_hash).toBe('__streak_bonus_payout_in_progress__');

    // Recovered DB + rerun → the sentinel keeps the bonus unclaimable: the 50
    // AE spend is NOT sent a second time (this was the old double-pay bug).
    streakBonusRewardRepository.update = realUpdate;
    resetScanWindow(rows);
    await service.requestManualRecheck(ADDRESS);
    const bonusSpends = spend.mock.calls.filter(
      (c) => c[0] === STREAK_BONUS_AETTOS,
    );
    expect(bonusSpends).toHaveLength(1);
  });

  it('schedules a backoff retry when a per-post payout send fails', async () => {
    tweetsByUserId['100'] = [
      {
        id: '5001',
        text: 'join',
        created_at: '2026-06-01T00:00:00Z',
        entities: { urls: [refUrl()] },
      },
    ];
    const { service, ledger, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });
    spend.mockImplementation(async () => {
      throw new Error('chain down');
    });

    await service.requestManualRecheck(ADDRESS);

    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe('failed');
    expect(ledger[0].error).toBe('payout_send_failed');
    expect(ledger[0].retry_count).toBe(1);
    expect(ledger[0].next_retry_at).toBeInstanceOf(Date);
    expect(ledger[0].tx_hash).toBeNull();
  });

  it('blocks a reward when the X identity is already rewarded on another address', async () => {
    tweetsByUserId['100'] = [
      {
        id: '6001',
        text: 'superhero.com @superhero_chain',
        created_at: '2026-06-01T00:00:00Z',
      },
    ];
    const { service, rows, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [
        baseRow(),
        {
          address: 'ak_otherclaimantaddress0000000000000000000000',
          x_username: 'poster',
          x_user_id: '100',
          status: 'paid',
        },
      ],
    });

    await service.requestManualRecheck(ADDRESS);

    expect(rows.get(ADDRESS)?.status).toBe('blocked_x_identity_conflict');
    expect(rows.get(ADDRESS)?.error).toBe('x_identity_already_rewarded');
    expect(spend).not.toHaveBeenCalled();
  });

  it('blocks BEFORE fetching posts when another pending row already holds the x_user_id', async () => {
    tweetsByUserId['100'] = [
      {
        id: '6101',
        text: 'superhero.com @superhero_chain',
        created_at: '2026-06-01T00:00:00Z',
      },
    ];
    const { service, rows, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [
        baseRow(),
        {
          address: 'ak_otherclaimantaddress0000000000000000000000',
          x_username: 'poster',
          x_user_id: '100',
          status: 'pending',
        },
      ],
    });

    await service.requestManualRecheck(ADDRESS);

    expect(rows.get(ADDRESS)?.status).toBe('blocked_x_identity_conflict');
    expect(spend).not.toHaveBeenCalled();
    // The (paid) tweets fetch was skipped entirely.
    const tweetCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([input]: [string]) => new URL(input).pathname.endsWith('/tweets'),
    );
    expect(tweetCalls).toHaveLength(0);
  });

  it('surfaces a pending streak bonus instead of reporting not_started', async () => {
    const { service, bonusRows } = makeService({
      rows: [{ address: ADDRESS, x_username: 'poster' }],
    });
    bonusRows.push({
      id: 1,
      address: ADDRESS,
      x_user_id: '100',
      streak_completed_day: '2026-06-03',
      status: 'pending',
      tx_hash: null,
    });

    const result = await service.getRewardStatus(ADDRESS);

    expect(result.streak_bonus_status).toBe('pending');
    expect(result.streak_bonus_paid_count).toBe(0);
  });

  it('claims the onboarding payout slot at most once', async () => {
    const { service } = makeService({
      rows: [{ address: ADDRESS, status: 'pending', tx_hash: null }],
    });

    const first = await (service as any).claimOnboardingPayoutAttempt(ADDRESS);
    const second = await (service as any).claimOnboardingPayoutAttempt(ADDRESS);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});

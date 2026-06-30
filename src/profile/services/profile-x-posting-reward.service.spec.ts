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
  PROFILE_X_REFERRAL_LINK_BASE_URL: 'https://superhero.com',
  PROFILE_X_REWARD_DAILY_CAP_HOURS: 24,
  PROFILE_X_REWARD_MIN_FOLLOWERS: 100,
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

import { buildTx, buildTxHash, Tag } from '@aeternity/aepp-sdk';
import { ProfileXPostingReward } from '../entities/profile-x-posting-reward.entity';
import { ProfileXPostRewardLedger } from '../entities/profile-x-post-reward-ledger.entity';
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
  // Tx hashes the middleware should report as on-chain (drives the
  // confirmation-pending finalizer). Empty by default → nothing is confirmed.
  let confirmedTxHashes: Set<string>;
  // Per-id HTTP status override for the by-id user lookup (e.g. 500 transient,
  // 404 definitively-gone). Absent id → normal success.
  let userIdLookupOverride: Record<string, number>;
  // Ids whose profile should come back WITHOUT public_metrics (null followers).
  let noMetricsUserIds: Set<string>;
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
    confirmedTxHashes = new Set<string>();
    userIdLookupOverride = {};
    noMetricsUserIds = new Set<string>();
    global.fetch = jest.fn().mockImplementation(async (input: string) => {
      const url = new URL(input);
      const path = url.pathname;
      // Middleware tx lookup used by the confirmation-pending finalizer.
      if (path.includes('/v3/txs/')) {
        const hash = decodeURIComponent(path.split('/').pop() || '');
        if (confirmedTxHashes.has(hash)) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ hash, block_height: 1 }),
          } as any;
        }
        return { ok: false, status: 404, text: async () => 'not found' } as any;
      }
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
              ...(noMetricsUserIds.has(id)
                ? {}
                : {
                    public_metrics: {
                      followers_count: followersByUserId[id] ?? 0,
                    },
                  }),
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
        const override = userIdLookupOverride[id];
        if (override) {
          return { ok: false, status: override, json: async () => ({}) } as any;
        }
        const username =
          Object.entries(userIdByUsername).find(([, v]) => v === id)?.[0] || '';
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              id,
              username,
              ...(noMetricsUserIds.has(id)
                ? {}
                : {
                    public_metrics: {
                      followers_count: followersByUserId[id] ?? 0,
                    },
                  }),
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
            // Per-post ledger inserts now run inside the scan transaction; route
            // them to the same in-memory ledger repo used outside it.
            if (entity === ProfileXPostRewardLedger) {
              return postRewardLedgerRepository;
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
      dataSource,
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
    expanded_url: `https://superhero.com?ref=${code}`,
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
    expect(result.error).toContain('100 followers');
    expect(result.min_followers_required).toBe(100);
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
    expect(link).toBe(`https://superhero.com?ref=${code}`);
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
    // Real broadcast hash persisted (non-null → row stays unclaimable, so no
    // double-spend) so the confirmation finalizer can later settle it on-chain.
    expect(ledger[0].tx_hash).toBe(`th_${PER_POST_AETTOS}`);
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
    // Real broadcast hash persisted (non-null → unclaimable).
    expect(rows.get(ADDRESS)?.tx_hash).toBe(`th_${ONBOARDING_AETTOS}`);
    expect(result.onboarding_status).toBe('pending');

    // Recovered DB + rerun → the real-hash row stays unclaimable (no re-send).
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
    expect(bonusRows[0].tx_hash).toBe(`th_${STREAK_BONUS_AETTOS}`);

    // Recovered DB + rerun → the real-hash row stays unclaimable: the 50 AE
    // spend is NOT sent a second time (this was the old double-pay bug).
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

  it('masks the X identity once the account has unlinked X but keeps paid history', async () => {
    const { service } = makeService({
      // Account no longer has an x link, but the reward row still references it.
      account: { address: ADDRESS, links: {} },
      rows: [
        baseRow({
          x_user_id: '100',
          status: 'paid',
          tx_hash: 'th_onboarding',
          follower_count: 1000,
          current_streak_days: 3,
          qualified_posts_count: 5,
        }),
      ],
    });

    const result = await service.getRewardStatus(ADDRESS);

    // Identity / active-scan fields are hidden.
    expect(result.x_username).toBeNull();
    expect(result.x_user_id).toBeNull();
    expect(result.referral_code).toBeNull();
    expect(result.referral_link).toBeNull();
    expect(result.follower_count).toBeNull();
    expect(result.current_streak_days).toBe(0);
    expect(result.qualified_posts_count).toBe(0);
    // Settled payout history is preserved.
    expect(result.status).toBe('paid');
    expect(result.onboarding_status).toBe('paid');
    expect(result.tx_hash).toBe('th_onboarding');
  });

  it('still shows the X identity while the account link matches the reward row', async () => {
    const { service } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow({ x_user_id: '100', follower_count: 1000 })],
    });

    const result = await service.getRewardStatus(ADDRESS);

    expect(result.x_username).toBe('poster');
    expect(result.x_user_id).toBe('100');
    expect(result.follower_count).toBe(1000);
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

  /* ---------------------------------------------------------------- */
  /* X identity reset on handle re-link (H1/H2)                        */
  /* ---------------------------------------------------------------- */

  it('resets the cached X identity when the linked handle changes, so the OLD account is never scanned or paid', async () => {
    // Row was last verified against account A (id 100); the account now links a
    // DIFFERENT handle poster2 (id 200). Account A has a referral post that
    // WOULD pay if it were still scanned.
    userIdByUsername = { poster: '100', poster2: '200' };
    followersByUserId = { '100': 5000, '200': 500 };
    tweetsByUserId['100'] = [
      {
        id: '9001',
        text: 'superhero.com',
        created_at: '2026-06-01T00:00:00Z',
        entities: { urls: [refUrl()] },
      },
    ];
    tweetsByUserId['200'] = [];
    const { service, rows, ledger, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster2' } },
      rows: [
        baseRow({
          x_user_id: '100',
          last_scanned_tweet_id: '8000',
          follower_count: 5000,
          current_streak_days: 2,
          qualified_posts_count: 3,
        }),
      ],
    });

    await service.requestManualRecheck(ADDRESS);

    // Identity migrated to the new handle, resolved fresh by username.
    expect(rows.get(ADDRESS)?.x_username).toBe('poster2');
    expect(rows.get(ADDRESS)?.x_user_id).toBe('200');
    // The stale id 100 was never fetched, and account A's post never ledgered.
    const idCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([input]: [string]) => new URL(input).pathname === '/2/users/100',
    );
    expect(idCalls).toHaveLength(0);
    expect(ledger).toHaveLength(0);
    expect(
      spend.mock.calls.filter((c) => c[0] === PER_POST_AETTOS),
    ).toHaveLength(0);
    // Stale streak/onboarding progress was cleared on the handle change.
    expect(rows.get(ADDRESS)?.current_streak_days).toBe(0);
  });

  it('keeps the cached X identity when the linked handle is unchanged', async () => {
    const { service, rows } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow({ x_user_id: '100', last_scanned_tweet_id: '8000' })],
    });

    await service.requestManualRecheck(ADDRESS);

    expect(rows.get(ADDRESS)?.x_user_id).toBe('100');
    // No reset → the cached id is used (by-id lookup), not a username lookup.
    const usernameCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([input]: [string]) =>
        new URL(input).pathname.startsWith('/2/users/by/username/'),
    );
    expect(usernameCalls).toHaveLength(0);
  });

  /* ---------------------------------------------------------------- */
  /* Frugal user lookup: fall back only on a definitive not-found      */
  /* ---------------------------------------------------------------- */

  it('does NOT spend a second username lookup when the cached id lookup fails transiently (5xx)', async () => {
    userIdLookupOverride['100'] = 503;
    const { service, rows } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow({ x_user_id: '100' })],
    });

    await service.requestManualRecheck(ADDRESS);

    const idCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([input]: [string]) => new URL(input).pathname === '/2/users/100',
    );
    const usernameCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([input]: [string]) =>
        new URL(input).pathname.startsWith('/2/users/by/username/'),
    );
    expect(idCalls).toHaveLength(1);
    expect(usernameCalls).toHaveLength(0);
    expect(rows.get(ADDRESS)?.error).toBe('x_user_lookup_failed');
  });

  it('falls back to the username lookup when the cached id is definitively gone (404)', async () => {
    userIdLookupOverride['100'] = 404;
    const { service } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow({ x_user_id: '100' })],
    });

    await service.requestManualRecheck(ADDRESS);

    const usernameCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([input]: [string]) =>
        new URL(input).pathname.startsWith('/2/users/by/username/'),
    );
    expect(usernameCalls).toHaveLength(1);
  });

  /* ---------------------------------------------------------------- */
  /* Confirmation-pending finalizer                                    */
  /* ---------------------------------------------------------------- */

  it('reconciles a confirmation-pending per-post payout to paid once the tx is seen on-chain', async () => {
    tweetsByUserId['100'] = [
      {
        id: '7001',
        text: 'join',
        created_at: '2026-06-01T00:00:00Z',
        entities: { urls: [refUrl()] },
      },
    ];
    const { service, rows, ledger, spend, postRewardLedgerRepository } =
      makeService({
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
    expect(ledger[0].error).toBe('payout_confirmation_pending');
    expect(ledger[0].tx_hash).toBe(`th_${PER_POST_AETTOS}`);

    // DB recovered + the tx is now visible on-chain → recovery pass settles it
    // WITHOUT re-sending.
    postRewardLedgerRepository.update = realUpdate;
    confirmedTxHashes.add(`th_${PER_POST_AETTOS}`);
    resetScanWindow(rows);
    await service.requestManualRecheck(ADDRESS);

    expect(ledger[0].status).toBe('paid');
    expect(ledger[0].error).toBeNull();
    expect(
      spend.mock.calls.filter((c) => c[0] === PER_POST_AETTOS),
    ).toHaveLength(1);
  });

  it('does NOT reconcile a confirmation-pending payout while the tx is not yet on-chain', async () => {
    tweetsByUserId['100'] = [
      {
        id: '7101',
        text: 'join',
        created_at: '2026-06-01T00:00:00Z',
        entities: { urls: [refUrl()] },
      },
    ];
    const { service, rows, ledger, postRewardLedgerRepository } = makeService({
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
    postRewardLedgerRepository.update = realUpdate;
    // confirmedTxHashes stays empty → middleware 404s → row stays pending.
    resetScanWindow(rows);
    await service.requestManualRecheck(ADDRESS);

    expect(ledger[0].status).not.toBe('paid');
    expect(ledger[0].error).toBe('payout_confirmation_pending');
  });

  /* ---------------------------------------------------------------- */
  /* Payout state-machine edge cases                                   */
  /* ---------------------------------------------------------------- */

  it('skips a per-post ledger row with an invalid amount instead of paying it', async () => {
    const { service, ledger, spend } = makeService({ rows: [] });
    ledger.push({
      id: '1',
      address: ADDRESS,
      x_user_id: '100',
      tweet_id: 't1',
      amount_aettos: '0',
      status: 'pending',
      tx_hash: null,
      retry_count: 0,
      next_retry_at: null,
    });

    const progressed = await (service as any).payLedgerRow(ledger[0]);

    expect(progressed).toBe(true);
    expect(ledger[0].status).toBe('skipped');
    expect(ledger[0].error).toBe('invalid_amount');
    expect(spend).not.toHaveBeenCalled();
  });

  it('skips a streak bonus row with a non-numeric amount instead of paying it', async () => {
    const { service, bonusRows, spend } = makeService({ rows: [] });
    bonusRows.push({
      id: 1,
      address: ADDRESS,
      x_user_id: '100',
      streak_completed_day: '2026-06-03',
      amount_aettos: 'not-a-number',
      status: 'pending',
      tx_hash: null,
      retry_count: 0,
      next_retry_at: null,
    });

    await (service as any).payStreakBonusRow(bonusRows[0]);

    expect(bonusRows[0].status).toBe('skipped');
    expect(bonusRows[0].error).toBe('invalid_amount');
    expect(spend).not.toHaveBeenCalled();
  });

  it('retries a failed per-post payout only once its backoff is due', async () => {
    const { service, ledger, spend } = makeService({ rows: [] });
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);
    ledger.push({
      id: '1',
      address: ADDRESS,
      x_user_id: '100',
      tweet_id: 't-future',
      amount_aettos: PER_POST_AETTOS,
      status: 'failed',
      tx_hash: null,
      retry_count: 1,
      next_retry_at: future,
    });
    ledger.push({
      id: '2',
      address: ADDRESS,
      x_user_id: '100',
      tweet_id: 't-due',
      amount_aettos: PER_POST_AETTOS,
      status: 'failed',
      tx_hash: null,
      retry_count: 1,
      next_retry_at: past,
    });

    await (service as any).payPendingLedger(ADDRESS);

    // Only the due row was paid; the not-yet-due row was left untouched.
    expect(ledger.find((r) => r.tweet_id === 't-due')?.status).toBe('paid');
    expect(ledger.find((r) => r.tweet_id === 't-future')?.status).toBe(
      'failed',
    );
    expect(spend).toHaveBeenCalledTimes(1);
  });

  it('computes exponential backoff capped at the configured maximum', () => {
    const { service } = makeService({ rows: [] });
    const delay = (n: number) => (service as any).getRetryDelaySeconds(n);
    expect(delay(1)).toBe(1); // base
    expect(delay(2)).toBe(2);
    expect(delay(3)).toBe(4);
    expect(delay(10)).toBe(60); // 2^9 = 512 → capped at max (60)
  });

  it('masks every payout in-progress sentinel from the public tx_hash', () => {
    const { service } = makeService({ rows: [] });
    const sanitize = (v: string | null) => (service as any).sanitizeTxHash(v);
    expect(sanitize('__posting_reward_payout_in_progress__')).toBeNull();
    expect(sanitize('__per_post_payout_in_progress__')).toBeNull();
    expect(sanitize('__streak_bonus_payout_in_progress__')).toBeNull();
    expect(sanitize('th_real')).toBe('th_real');
  });

  /* ---------------------------------------------------------------- */
  /* Streak day-math + idempotency edge cases                          */
  /* ---------------------------------------------------------------- */

  it('ignores a referral post older than the last qualifying day (does not reset the streak)', () => {
    const { service } = makeService({ rows: [] });
    const reward: any = {
      address: ADDRESS,
      last_qualifying_post_day: '2026-06-05',
      current_streak_days: 2,
    };
    const completed = (service as any).updateStreak(reward, [
      {
        id: '1',
        text: '',
        urls: [],
        createdAt: new Date('2026-06-02T00:00:00Z'),
      },
    ]);
    expect(completed).toEqual([]);
    // Older day is skipped: streak and anchor unchanged.
    expect(reward.current_streak_days).toBe(2);
    expect(reward.last_qualifying_post_day).toBe('2026-06-05');
  });

  it('does not create a duplicate streak bonus when the same completed window is re-scanned', async () => {
    const days = ['2026-06-01', '2026-06-02', '2026-06-03'];
    tweetsByUserId['100'] = days.map((d, i) => ({
      id: `33${i}`,
      text: `day ${i}`,
      created_at: `${d}T08:00:00Z`,
      entities: { urls: [refUrl()] },
    }));
    const { service, rows, bonusRows, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });

    await service.requestManualRecheck(ADDRESS);
    expect(bonusRows).toHaveLength(1);

    // Re-scan the SAME window (reset cursor + scan slot): the unique completion
    // constraint keeps it idempotent — no second bonus row, no second payout.
    rows.set(ADDRESS, {
      ...rows.get(ADDRESS)!,
      last_scanned_tweet_id: null,
      last_x_api_scan_at: new Date(Date.now() - 48 * 3600 * 1000),
    });
    await service.requestManualRecheck(ADDRESS);

    expect(bonusRows).toHaveLength(1);
    expect(
      spend.mock.calls.filter((c) => c[0] === STREAK_BONUS_AETTOS),
    ).toHaveLength(1);
  });

  it('reports follower_count_unavailable (and skips the posts fetch) when X omits public_metrics', async () => {
    noMetricsUserIds.add('100');
    const { service, rows } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });

    await service.requestManualRecheck(ADDRESS);

    expect(rows.get(ADDRESS)?.error).toBe('follower_count_unavailable');
    const tweetCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([input]: [string]) => new URL(input).pathname.endsWith('/tweets'),
    );
    expect(tweetCalls).toHaveLength(0);
  });

  it('preserves settled per-post totals in the status payload after a paid onboarding', async () => {
    const { service, ledger } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow({ x_user_id: '100', status: 'paid' })],
    });
    ledger.push({
      id: '1',
      address: ADDRESS,
      x_user_id: '100',
      tweet_id: 't1',
      amount_aettos: PER_POST_AETTOS,
      status: 'paid',
    });

    const result = await service.getRewardStatus(ADDRESS);

    expect(result.per_post_total_paid_count).toBe(1);
    expect(result.per_post_total_paid_aettos).toBe(PER_POST_AETTOS);
  });

  /* ---------------------------------------------------------------- */
  /* Post-broadcast failure (the SDK broadcasts then polls for mining; */
  /* a poll timeout rejects spend() AFTER the tx is on-chain). These   */
  /* lock in that such a payout is NEVER re-sent (no double-pay).      */
  /* ---------------------------------------------------------------- */

  // Mimic aepp-sdk's TxTimedOutError: the real hash lives only in the message
  // (and would be on the attached rawTx); spend() rejects with this AFTER the
  // SpendTx is already broadcast/mined.
  const txTimeout = (hash: string) =>
    Object.assign(
      new Error(`Giving up after 5 blocks mined, transaction hash: ${hash}`),
      { name: 'TxTimedOutError' },
    );

  it('records an onboarding payout that times out AFTER broadcasting as confirmation-pending, never re-sends, and reconciles from chain', async () => {
    tweetsByUserId['100'] = [
      {
        id: '8101',
        text: 'gm superhero.com',
        created_at: '2026-06-01T00:00:00Z',
      },
    ];
    const { service, rows, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });
    spend.mockImplementation(async () => {
      throw txTimeout('th_onboardtimeoutaa');
    });

    let result = await service.requestManualRecheck(ADDRESS);

    expect(spend).toHaveBeenCalledTimes(1);
    // The REAL broadcast hash is recovered and persisted (non-null → the row
    // stays unclaimable), NOT marked failed (which would re-send → double-pay).
    expect(rows.get(ADDRESS)?.tx_hash).toBe('th_onboardtimeoutaa');
    expect(rows.get(ADDRESS)?.error).toBe('payout_confirmation_pending');
    expect(rows.get(ADDRESS)?.status).not.toBe('paid');
    expect(rows.get(ADDRESS)?.status).not.toBe('failed');
    expect(result.onboarding_status).toBe('pending');

    // Not yet visible on-chain → a re-check must NOT broadcast a second time.
    resetScanWindow(rows);
    result = await service.requestManualRecheck(ADDRESS);
    expect(spend).toHaveBeenCalledTimes(1);
    expect(result.onboarding_status).toBe('pending');

    // Once the middleware sees the tx, the finalizer settles it from chain
    // (still no second spend).
    confirmedTxHashes.add('th_onboardtimeoutaa');
    resetScanWindow(rows);
    result = await service.requestManualRecheck(ADDRESS);
    expect(spend).toHaveBeenCalledTimes(1);
    expect(result.onboarding_status).toBe('paid');
  });

  it('records a per-post payout that times out AFTER broadcasting as confirmation-pending and never re-sends', async () => {
    tweetsByUserId['100'] = [
      {
        id: '8201',
        text: 'join',
        created_at: '2026-06-01T00:00:00Z',
        entities: { urls: [refUrl()] },
      },
    ];
    const { service, rows, ledger, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });
    spend.mockImplementation(async (amount: string) => {
      if (amount === PER_POST_AETTOS) {
        throw txTimeout('th_perposttimeoutbb');
      }
      return { hash: `th_${amount}` };
    });

    await service.requestManualRecheck(ADDRESS);

    expect(
      spend.mock.calls.filter((c) => c[0] === PER_POST_AETTOS),
    ).toHaveLength(1);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].tx_hash).toBe('th_perposttimeoutbb');
    expect(ledger[0].error).toBe('payout_confirmation_pending');
    expect(ledger[0].status).not.toBe('paid');

    // Rerun while not on-chain → the 0.1 AE per-post reward is NOT re-sent.
    resetScanWindow(rows);
    await service.requestManualRecheck(ADDRESS);
    expect(
      spend.mock.calls.filter((c) => c[0] === PER_POST_AETTOS),
    ).toHaveLength(1);
  });

  it('records a streak-bonus payout that times out AFTER broadcasting as confirmation-pending, never re-sends, and reconciles from chain', async () => {
    tweetsByUserId['100'] = [
      {
        id: '8301',
        text: 'd1',
        created_at: '2026-06-01T08:00:00Z',
        entities: { urls: [refUrl()] },
      },
      {
        id: '8302',
        text: 'd2',
        created_at: '2026-06-02T08:00:00Z',
        entities: { urls: [refUrl()] },
      },
      {
        id: '8303',
        text: 'd3',
        created_at: '2026-06-03T08:00:00Z',
        entities: { urls: [refUrl()] },
      },
    ];
    const { service, rows, bonusRows, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });
    spend.mockImplementation(async (amount: string) => {
      if (amount === STREAK_BONUS_AETTOS) {
        throw txTimeout('th_streaktimeoutcc');
      }
      return { hash: `th_${amount}` };
    });

    await service.requestManualRecheck(ADDRESS);

    expect(bonusRows).toHaveLength(1);
    expect(bonusRows[0].tx_hash).toBe('th_streaktimeoutcc');
    expect(bonusRows[0].error).toBe('payout_confirmation_pending');
    expect(bonusRows[0].status).not.toBe('paid');

    // Rerun while not on-chain → the 50 AE bonus is NOT broadcast again.
    resetScanWindow(rows);
    await service.requestManualRecheck(ADDRESS);
    expect(
      spend.mock.calls.filter((c) => c[0] === STREAK_BONUS_AETTOS),
    ).toHaveLength(1);

    // Once on-chain, the finalizer settles it (still no re-send).
    confirmedTxHashes.add('th_streaktimeoutcc');
    resetScanWindow(rows);
    await service.requestManualRecheck(ADDRESS);
    expect(
      spend.mock.calls.filter((c) => c[0] === STREAK_BONUS_AETTOS),
    ).toHaveLength(1);
    const status = await service.getRewardStatus(ADDRESS);
    expect(status.streak_bonus_status).toBe('paid');
  });

  it('backs off a failed onboarding payout (no immediate re-send) and retries once the backoff elapses', async () => {
    tweetsByUserId['100'] = [
      {
        id: '8401',
        text: 'gm superhero.com',
        created_at: '2026-06-01T00:00:00Z',
      },
    ];
    const { service, rows, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });
    // A pre-broadcast failure (plain error, no rawTx) → genuinely retryable.
    spend.mockImplementationOnce(async () => {
      throw new Error('chain down');
    });

    await service.requestManualRecheck(ADDRESS);

    expect(spend).toHaveBeenCalledTimes(1);
    const failed = rows.get(ADDRESS)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('payout_send_failed');
    expect(failed.retry_count).toBe(1);
    expect(failed.next_retry_at).toBeInstanceOf(Date);
    expect(new Date(failed.next_retry_at as Date).getTime()).toBeGreaterThan(
      Date.now(),
    );

    // Immediate re-check: the backoff has not elapsed → must NOT re-send.
    resetScanWindow(rows);
    await service.requestManualRecheck(ADDRESS);
    expect(spend).toHaveBeenCalledTimes(1);

    // Backoff elapsed → the retry goes through and settles.
    rows.set(ADDRESS, {
      ...rows.get(ADDRESS)!,
      next_retry_at: new Date(Date.now() - 1000),
    });
    resetScanWindow(rows);
    await service.requestManualRecheck(ADDRESS);
    expect(spend).toHaveBeenCalledTimes(2);
    expect(rows.get(ADDRESS)?.status).toBe('paid');
  });

  it('caps the tweet scan at the pagination limit, flags truncation, and still advances the cursor', async () => {
    const { service, rows, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });
    const baseFetch = global.fetch as jest.Mock;
    let tweetPages = 0;
    global.fetch = jest.fn(async (input: string, init?: any) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/tweets')) {
        tweetPages += 1;
        const token = url.searchParams.get('pagination_token');
        const page = token ? Number(token) : 0;
        // Strictly-decreasing ids (X returns newest-first); always another page.
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: String(100000 - page),
                text: 'hello world',
                created_at: '2026-06-01T00:00:00Z',
              },
            ],
            meta: { newest_id: '100000', next_token: String(page + 1) },
          }),
        } as any;
      }
      return baseFetch(input, init);
    }) as any;

    await service.requestManualRecheck(ADDRESS);

    // Hard cap on pages fetched (DEFAULT_MAX_TWEET_PAGE_COUNT = 20): the loop
    // can never run unbounded against a prolific account.
    expect(tweetPages).toBe(20);
    const row = rows.get(ADDRESS)!;
    expect(row.error).toBe('x_posts_scan_truncated');
    // Cursor advances to the newest seen so the next scan does not re-fetch.
    expect(row.last_scanned_tweet_id).toBe('100000');
    // None of the (keyword-less) posts qualified → nothing paid.
    expect(spend).not.toHaveBeenCalled();

    global.fetch = baseFetch;
  });

  it('marks x_posts_fetch_failed and ledgers/pays nothing when the tweets fetch returns non-OK', async () => {
    const { service, rows, ledger, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });
    const baseFetch = global.fetch as jest.Mock;
    global.fetch = jest.fn(async (input: string, init?: any) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/tweets')) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ detail: 'boom' }),
        } as any;
      }
      return baseFetch(input, init);
    }) as any;

    await service.requestManualRecheck(ADDRESS);

    expect(rows.get(ADDRESS)?.error).toBe('x_posts_fetch_failed');
    expect(ledger).toHaveLength(0);
    expect(spend).not.toHaveBeenCalled();

    global.fetch = baseFetch;
  });

  it('warns about payouts left stuck in-progress by a crash (manual reconciliation needed)', async () => {
    const { service, ledger, bonusRows, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [
        baseRow({
          x_user_id: '100',
          status: 'pending',
          tx_hash: '__posting_reward_payout_in_progress__',
        }),
      ],
    });
    ledger.push({
      id: '1',
      address: ADDRESS,
      x_user_id: '100',
      tweet_id: 't1',
      amount_aettos: PER_POST_AETTOS,
      status: 'pending',
      tx_hash: '__per_post_payout_in_progress__',
      error: null,
      next_retry_at: null,
    });
    bonusRows.push({
      id: 1,
      address: ADDRESS,
      x_user_id: '100',
      streak_completed_day: '2026-06-03',
      amount_aettos: STREAK_BONUS_AETTOS,
      status: 'pending',
      tx_hash: '__streak_bonus_payout_in_progress__',
      error: null,
      next_retry_at: null,
    });
    const warnSpy = jest.spyOn((service as any).logger, 'warn');

    // The recovery pass (recheck step 1) surfaces stuck sentinels without
    // re-sending; call it directly to isolate the warnings from a fresh scan.
    await (service as any).runPayouts(ADDRESS, null, { logStuckPayouts: true });

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(
      messages.some(
        (m) => m.includes('onboarding payout') && m.includes('stuck'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) => m.includes('per-post payout') && m.includes('stuck'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) => m.includes('streak bonus payout') && m.includes('stuck'),
      ),
    ).toBe(true);
    // Stuck (non-null tx_hash) rows are unclaimable → nothing is re-sent.
    expect(spend).not.toHaveBeenCalled();
  });

  it('stops the per-post drain loop without spending when a due row cannot be claimed (in-progress sentinel)', async () => {
    const { service, ledger, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow({ x_user_id: '100' })],
    });
    ledger.push({
      id: '1',
      address: ADDRESS,
      x_user_id: '100',
      tweet_id: 't1',
      amount_aettos: PER_POST_AETTOS,
      status: 'pending',
      tx_hash: '__per_post_payout_in_progress__',
      error: null,
      next_retry_at: null,
    });

    await (service as any).payPendingLedger(ADDRESS);

    expect(spend).not.toHaveBeenCalled();
    expect(ledger[0].status).toBe('pending');
    expect(ledger[0].tx_hash).toBe('__per_post_payout_in_progress__');
  });

  it('reports streak_bonus_status failed when the latest streak bonus row failed', async () => {
    const { service, bonusRows } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow({ x_user_id: '100', status: 'paid' })],
    });
    bonusRows.push(
      {
        id: 1,
        address: ADDRESS,
        x_user_id: '100',
        streak_completed_day: '2026-06-03',
        amount_aettos: STREAK_BONUS_AETTOS,
        status: 'paid',
      },
      {
        id: 2,
        address: ADDRESS,
        x_user_id: '100',
        streak_completed_day: '2026-06-06',
        amount_aettos: STREAK_BONUS_AETTOS,
        status: 'failed',
      },
    );

    const status = await service.getRewardStatus(ADDRESS);

    expect(status.streak_bonus_status).toBe('failed');
    expect(status.streak_bonus_paid_count).toBe(1);
  });

  it('pickNewestTweetId picks the numerically larger id and falls back to string compare', () => {
    const { service } = makeService();
    const pick = (a: string | null, b: string | null) =>
      (service as any).pickNewestTweetId(a, b);
    expect(pick(null, '5')).toBe('5');
    expect(pick('5', null)).toBe('5');
    // Numeric (snowflake) comparison, NOT lexicographic: '100' > '99'.
    expect(pick('99', '100')).toBe('100');
    expect(pick('100', '99')).toBe('100');
    // Non-numeric ids fall back to a string comparison.
    expect(pick('abc', 'abd')).toBe('abd');
  });

  it('retries minting a referral code on a unique-collision and still returns a valid code', async () => {
    const { service, postingRewardRepository } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow({ referral_code: null })],
    });
    let saves = 0;
    const realSave = postingRewardRepository.save;
    postingRewardRepository.save = jest.fn(async (v: any) => {
      if (v.referral_code) {
        saves += 1;
        if (saves <= 2) {
          throw {
            driverError: {
              code: '23505',
              constraint: 'ux_profile_x_posting_rewards_referral_code',
            },
          };
        }
      }
      return realSave(v);
    });

    const result = await service.getOrCreateReferralLink(ADDRESS);

    expect(result.code).toMatch(/^[a-z0-9]{12}$/);
    // First two mint attempts collided; the third persisted.
    expect(saves).toBe(3);
    expect(result.link).toContain(`ref=${result.code}`);
  });

  /* ---------------------------------------------------------------- */
  /* Ambiguous (non-timeout) post-broadcast failure: only a tx that   */
  /* the chain actually has is treated as broadcast; everything else  */
  /* retries. This narrows the double-pay window beyond TxTimedOut.    */
  /* ---------------------------------------------------------------- */

  // A real signed-tx-shaped value whose hash is deterministic, so the test can
  // both attach it to the error (as the SDK does) and pre-confirm it on-chain.
  const spendRawTx = (nonce: number) =>
    buildTx({
      tag: Tag.SpendTx,
      senderId: ADDRESS,
      recipientId: ADDRESS,
      amount: 1n,
      fee: 20000000000000n,
      nonce,
      ttl: 0,
      payload: 'ba_Xfbg4g==',
    });

  it('treats a non-timeout post-broadcast failure as broadcast ONLY when the tx is on-chain (no re-send)', async () => {
    tweetsByUserId['100'] = [
      {
        id: '8501',
        text: 'join',
        created_at: '2026-06-01T00:00:00Z',
        entities: { urls: [refUrl()] },
      },
    ];
    const { service, rows, ledger, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });
    const rawTx = spendRawTx(7);
    const rawTxHash = buildTxHash(rawTx);
    // The node accepted the tx (it is on-chain) but poll() then hit a transient
    // node error — NOT a TxTimedOutError, so only the chain lookup proves it was
    // broadcast.
    confirmedTxHashes.add(rawTxHash);
    spend.mockImplementation(async (amount: string) => {
      if (amount === PER_POST_AETTOS) {
        throw Object.assign(new Error('node 503 during poll'), { rawTx });
      }
      return { hash: `th_${amount}` };
    });

    await service.requestManualRecheck(ADDRESS);

    expect(ledger).toHaveLength(1);
    expect(ledger[0].tx_hash).toBe(rawTxHash);
    expect(ledger[0].error).toBe('payout_confirmation_pending');
    expect(ledger[0].status).not.toBe('paid');

    // Rerun → reconciled from chain, and the per-post reward is never re-sent.
    resetScanWindow(rows);
    await service.requestManualRecheck(ADDRESS);
    expect(
      spend.mock.calls.filter((c) => c[0] === PER_POST_AETTOS),
    ).toHaveLength(1);
    expect(ledger[0].status).toBe('paid');
  });

  it('retries a non-timeout send failure whose tx never reached the chain', async () => {
    tweetsByUserId['100'] = [
      {
        id: '8601',
        text: 'join',
        created_at: '2026-06-01T00:00:00Z',
        entities: { urls: [refUrl()] },
      },
    ];
    const { service, ledger, spend } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });
    const rawTx = spendRawTx(9);
    // NOT added to confirmedTxHashes → not on chain → genuinely failed → retry.
    spend.mockImplementation(async (amount: string) => {
      if (amount === PER_POST_AETTOS) {
        throw Object.assign(new Error('node rejected: nonce too low'), {
          rawTx,
        });
      }
      return { hash: `th_${amount}` };
    });

    await service.requestManualRecheck(ADDRESS);

    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe('failed');
    expect(ledger[0].error).toBe('payout_send_failed');
    expect(ledger[0].tx_hash).toBeNull();
    expect(ledger[0].next_retry_at).toBeInstanceOf(Date);
  });

  /* ---------------------------------------------------------------- */
  /* Intake (on-chain X link events) + identity lifecycle             */
  /* ---------------------------------------------------------------- */

  it('keeps the earliest verified_at across out-of-order link events', async () => {
    const { service, rows } = makeService({
      rows: [
        baseRow({
          verified_at: new Date('2026-06-10T00:00:00Z'),
          x_user_id: '100',
        }),
      ],
    });
    const ms = (iso: string) => String(new Date(iso).getTime());

    await service.upsertVerifiedCandidate(
      ADDRESS,
      'poster',
      ms('2026-06-05T00:00:00Z'),
    );
    expect(new Date(rows.get(ADDRESS)!.verified_at as Date).toISOString()).toBe(
      '2026-06-05T00:00:00.000Z',
    );

    // A LATER event does not push verified_at forward again.
    await service.upsertVerifiedCandidate(
      ADDRESS,
      'poster',
      ms('2026-06-20T00:00:00Z'),
    );
    expect(new Date(rows.get(ADDRESS)!.verified_at as Date).toISOString()).toBe(
      '2026-06-05T00:00:00.000Z',
    );
  });

  it('does not reset a paid row back to pending on a re-link event', async () => {
    const { service, rows } = makeService({
      rows: [
        baseRow({
          status: 'paid',
          x_user_id: '100',
          tx_hash: 'th_paidalready',
        }),
      ],
    });

    await service.upsertVerifiedCandidate(ADDRESS, 'poster');

    expect(rows.get(ADDRESS)?.status).toBe('paid');
    expect(rows.get(ADDRESS)?.tx_hash).toBe('th_paidalready');
  });

  it('skips intake (writes no row) for an invalid X username', async () => {
    const { service, rows, postingRewardRepository } = makeService();

    await service.upsertVerifiedCandidate(ADDRESS, '   ');

    expect(rows.size).toBe(0);
    expect(postingRewardRepository.save).not.toHaveBeenCalled();
  });

  it('processes a given source tx hash only once (intake dedup)', async () => {
    const { service } = makeService();
    const spy = jest.spyOn(service, 'upsertVerifiedCandidate');

    await service.upsertVerifiedCandidateFromTx(
      ADDRESS,
      'poster',
      undefined,
      'tx_dedup_1',
    );
    await service.upsertVerifiedCandidateFromTx(
      ADDRESS,
      'poster',
      undefined,
      'tx_dedup_1',
    );

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('masks an unlinked X identity then self-heals once the account re-links', async () => {
    const account: any = { address: ADDRESS, links: { x: 'poster' } };
    const { service } = makeService({
      account,
      rows: [baseRow({ x_user_id: '100', status: 'paid' })],
    });

    // Unlink: the account no longer carries the x link.
    account.links = {};
    let status = await service.getRewardStatus(ADDRESS);
    expect(status.x_username).toBeNull();
    expect(status.referral_code).toBeNull();
    // Settled payout history is preserved.
    expect(status.status).toBe('paid');

    // Re-link the SAME handle → the live identity returns (self-heal).
    account.links = { x: 'poster' };
    status = await service.getRewardStatus(ADDRESS);
    expect(status.x_username).toBe('poster');
    expect(status.referral_code).toBe('codetest0001');
  });

  it('does NOT block a scan when another row shares the username but is unpaid and unresolved', async () => {
    const OTHER = ADDRESS.replace('ak_2EZ', 'ak_2EX');
    tweetsByUserId['100'] = [
      {
        id: '9001',
        text: 'gm superhero.com',
        created_at: '2026-06-01T00:00:00Z',
      },
    ];
    const { service, rows } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [
        baseRow(),
        {
          address: OTHER,
          x_username: 'poster',
          status: 'pending',
          x_user_id: null,
        },
      ],
    });

    const result = await service.requestManualRecheck(ADDRESS);

    expect(rows.get(ADDRESS)?.status).not.toBe('blocked_x_identity_conflict');
    expect(result.onboarding_status).toBe('paid');
  });

  it('excludes malformed (non-numeric) ledger amounts from the paid totals', async () => {
    const { service, ledger } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow({ x_user_id: '100', status: 'paid' })],
    });
    ledger.push(
      {
        id: '1',
        address: ADDRESS,
        x_user_id: '100',
        tweet_id: 't1',
        amount_aettos: PER_POST_AETTOS,
        status: 'paid',
      },
      {
        id: '2',
        address: ADDRESS,
        x_user_id: '100',
        tweet_id: 't2',
        amount_aettos: 'not-a-number',
        status: 'paid',
      },
      {
        id: '3',
        address: ADDRESS,
        x_user_id: '100',
        tweet_id: 't3',
        amount_aettos: PER_POST_AETTOS,
        status: 'pending',
      },
    );

    const status = await service.getRewardStatus(ADDRESS);

    // Only the one paid, numeric row counts toward the public totals.
    expect(status.per_post_total_paid_count).toBe(1);
    expect(status.per_post_total_paid_aettos).toBe(PER_POST_AETTOS);
  });

  /* ---------------------------------------------------------------- */
  /* Identity binding: a paid/earning address is committed to ONE X    */
  /* identity and cannot farm per-post/streak across re-linked handles */
  /* ---------------------------------------------------------------- */

  it('does not let a paid address farm per-post/streak by re-linking a DIFFERENT X handle', async () => {
    userIdByUsername = { poster: '100', poster2: '200' };
    followersByUserId = { '100': 5000, '200': 5000 };
    // Identity A earns onboarding via a keyword-only post (no per-post ledger).
    tweetsByUserId['100'] = [
      {
        id: '7001',
        text: 'gm superhero.com',
        created_at: '2026-06-01T00:00:00Z',
      },
    ];
    // Identity B (a DIFFERENT X account) has referral posts on 3 consecutive days
    // that WOULD pay per-post and complete a streak (length 3) if scanned.
    tweetsByUserId['200'] = [
      {
        id: '8001',
        text: 'd1',
        created_at: '2026-06-10T00:00:00Z',
        entities: { urls: [refUrl()] },
      },
      {
        id: '8002',
        text: 'd2',
        created_at: '2026-06-11T00:00:00Z',
        entities: { urls: [refUrl()] },
      },
      {
        id: '8003',
        text: 'd3',
        created_at: '2026-06-12T00:00:00Z',
        entities: { urls: [refUrl()] },
      },
    ];
    const account: any = { address: ADDRESS, links: { x: 'poster' } };
    const { service, rows, ledger, bonusRows, spend } = makeService({
      account,
      rows: [baseRow()],
    });

    // 1. First scan with handle A → onboarding paid, address bound to id 100.
    await service.requestManualRecheck(ADDRESS);
    expect(rows.get(ADDRESS)?.status).toBe('paid');
    expect(rows.get(ADDRESS)?.rewarded_x_user_id).toBe('100');
    const onboardingSpends = spend.mock.calls.filter(
      (c) => c[0] === ONBOARDING_AETTOS,
    ).length;

    // 2. Re-link a DIFFERENT handle (id 200) to the SAME address.
    account.links = { x: 'poster2' };
    await service.upsertVerifiedCandidate(ADDRESS, 'poster2');
    // The binding must survive the handle-change reset.
    expect(rows.get(ADDRESS)?.rewarded_x_user_id).toBe('100');
    resetScanWindow(rows);

    // 3. Scan with handle B → blocked: nothing accrues or pays for id 200.
    await service.requestManualRecheck(ADDRESS);

    expect(rows.get(ADDRESS)?.error).toBe('x_identity_already_rewarded');
    expect(rows.get(ADDRESS)?.rewarded_x_user_id).toBe('100');
    expect(ledger).toHaveLength(0); // no per-post ledger for the new identity
    expect(bonusRows).toHaveLength(0); // no streak bonus for the new identity
    expect(
      spend.mock.calls.filter((c) => c[0] === PER_POST_AETTOS),
    ).toHaveLength(0);
    expect(
      spend.mock.calls.filter((c) => c[0] === STREAK_BONUS_AETTOS),
    ).toHaveLength(0);
    // Onboarding is preserved and never runs a second time.
    expect(
      spend.mock.calls.filter((c) => c[0] === ONBOARDING_AETTOS),
    ).toHaveLength(onboardingSpends);
    expect(rows.get(ADDRESS)?.status).toBe('paid');
  });

  it('still rewards a genuine handle RENAME (same x_user_id) after binding', async () => {
    userIdByUsername = { poster: '100', poster_renamed: '100' };
    followersByUserId = { '100': 5000 };
    tweetsByUserId['100'] = [
      {
        id: '7001',
        text: 'gm superhero.com',
        created_at: '2026-06-01T00:00:00Z',
      },
    ];
    const account: any = { address: ADDRESS, links: { x: 'poster' } };
    const { service, rows, ledger } = makeService({
      account,
      rows: [baseRow()],
    });

    // 1. Earn onboarding with handle A → bound to id 100.
    await service.requestManualRecheck(ADDRESS);
    expect(rows.get(ADDRESS)?.rewarded_x_user_id).toBe('100');

    // 2. The SAME X account is renamed (still id 100) and re-linked, then posts a
    //    NEW referral tweet on a new day.
    account.links = { x: 'poster_renamed' };
    await service.upsertVerifiedCandidate(ADDRESS, 'poster_renamed');
    tweetsByUserId['100'] = [
      ...tweetsByUserId['100'],
      {
        id: '7100',
        text: 'd-new',
        created_at: '2026-06-05T00:00:00Z',
        entities: { urls: [refUrl()] },
      },
    ];
    resetScanWindow(rows);

    // 3. Scan → NOT blocked (same id); the new referral post earns per-post.
    await service.requestManualRecheck(ADDRESS);

    expect(rows.get(ADDRESS)?.error).not.toBe('x_identity_already_rewarded');
    expect(rows.get(ADDRESS)?.x_user_id).toBe('100');
    // The new referral post (same identity) ledgered AND paid out.
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe('paid');
  });

  it('does not bind an identity that earned nothing, so the user can still switch handles', async () => {
    userIdByUsername = { poster: '100', poster2: '200' };
    followersByUserId = { '100': 5000, '200': 5000 };
    // Handle A: a non-qualifying tweet (no keyword, no referral) → earns nothing,
    // so the address must NOT be bound to it (the user may have linked the wrong
    // handle by mistake).
    tweetsByUserId['100'] = [
      {
        id: '6001',
        text: 'just a normal tweet',
        created_at: '2026-06-01T00:00:00Z',
      },
    ];
    // Handle B: a referral post that SHOULD pay once B is linked.
    tweetsByUserId['200'] = [
      {
        id: '6100',
        text: 'd1',
        created_at: '2026-06-02T00:00:00Z',
        entities: { urls: [refUrl()] },
      },
    ];
    const account: any = { address: ADDRESS, links: { x: 'poster' } };
    const { service, rows, ledger } = makeService({
      account,
      rows: [baseRow()],
    });

    // 1. Scan A → nothing qualifies, so no identity binding.
    await service.requestManualRecheck(ADDRESS);
    expect(rows.get(ADDRESS)?.rewarded_x_user_id == null).toBe(true);

    // 2. Switch to handle B (user corrects a wrong link before earning anything).
    account.links = { x: 'poster2' };
    await service.upsertVerifiedCandidate(ADDRESS, 'poster2');
    resetScanWindow(rows);

    // 3. Scan B → NOT blocked; B's referral post binds and earns.
    await service.requestManualRecheck(ADDRESS);

    expect(rows.get(ADDRESS)?.error).not.toBe('x_identity_already_rewarded');
    expect(rows.get(ADDRESS)?.rewarded_x_user_id).toBe('200');
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe('paid');
  });

  /* ---------------------------------------------------------------- */
  /* Daily scan slot: an UNEXPECTED scan failure must surface (not a   */
  /* false success) and release the slot; a HANDLED X failure must     */
  /* still consume it (fail-closed for the API budget).                */
  /* ---------------------------------------------------------------- */

  it('surfaces the failure and releases the scan slot when the guarded scan throws', async () => {
    tweetsByUserId['100'] = [];
    const { service, rows, dataSource } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });
    // The scan persists its results in a DB transaction; simulate that failing.
    dataSource.transaction.mockRejectedValueOnce(
      new Error('db transaction failed'),
    );

    // The API must NOT report success — it must surface the failure.
    await expect(service.requestManualRecheck(ADDRESS)).rejects.toMatchObject({
      status: 503,
    });

    // The slot was RELEASED (rolled back to its prior null value), so the user is
    // not locked out for the whole window by a transient infra failure.
    expect(rows.get(ADDRESS)?.last_x_api_scan_at == null).toBe(true);
    // A fresh claim now succeeds (the slot is free again).
    const reclaimed = await (service as any).claimDailyScanSlot(ADDRESS);
    expect(reclaimed).toBe(true);
  });

  it('keeps the scan slot consumed on a HANDLED X failure (fail-closed, no throw)', async () => {
    // The linked handle does not resolve → resolveXUserProfile returns null and
    // the scan records an error and RETURNS (it does not throw), so the slot must
    // stay consumed to prevent draining the X budget via retries.
    userIdByUsername = {};
    const { service, rows } = makeService({
      account: { address: ADDRESS, links: { x: 'poster' } },
      rows: [baseRow()],
    });

    const result = await service.requestManualRecheck(ADDRESS);

    // Returns a status payload (no throw) reflecting the X failure.
    expect(result).toBeDefined();
    expect(rows.get(ADDRESS)?.error).toBe('x_user_lookup_failed');
    // Slot consumed → an immediate re-claim within the window is refused.
    expect(rows.get(ADDRESS)?.last_x_api_scan_at).toBeInstanceOf(Date);
    const reclaimed = await (service as any).claimDailyScanSlot(ADDRESS);
    expect(reclaimed).toBe(false);
  });
});

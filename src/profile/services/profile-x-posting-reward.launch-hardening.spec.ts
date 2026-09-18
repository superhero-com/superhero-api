/* eslint-disable @typescript-eslint/no-require-imports */
// Marks this file as a module so its top-level constants do not collide with
// the sibling spec that shares their names in the global script scope.
export {};

/**
 * The two guarantees that let the unauthenticated status endpoint call into the
 * reward pipeline:
 *
 *  1. An X outage on OUR side never costs the user a lookup strike. Five
 *     strikes write `x_user_lookup_blocked`, which only an on-chain re-link
 *     clears — so conflating "we could not ask X" with "that handle does not
 *     exist" turns a credential expiry into a mass lockout.
 *  2. The settle pass, which deliberately sits ahead of the once-a-day scan cap,
 *     does no work for a wallet that is not owed anything. Without that, any
 *     stranger naming any address walks three payout paths and the spend queue.
 */
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
  PROFILE_X_ONBOARDING_REWARD_ENABLED: true,
  PROFILE_X_ONBOARDING_THRESHOLD: 1,
  PROFILE_X_PERPOST_REWARD_ENABLED: true,
  PROFILE_X_REWARD_STREAK_BONUS_ENABLED: true,
};

type Harness = {
  service: any;
  row: any;
  xRead: jest.Mock;
  getToken: jest.Mock;
  recordAttempt: jest.Mock;
};

/** Shape `fetchXReadWithAuthFallback` resolves to. */
const xResponse = (status: number, body: any) => ({
  response: { ok: status >= 200 && status < 300, status } as any,
  body,
  baseUrl: 'https://api.x.com',
});

/**
 * Build the service under an isolated module registry, so the module-level
 * constants can differ per case (they are read at import time).
 */
const build = async (
  rowOverride: Record<string, unknown>,
  opts: {
    token?: string | null;
    xRead?: jest.Mock;
    linkedX?: string | null;
    ledgerDue?: number;
    streakDue?: number;
    constants?: Record<string, unknown>;
  } = {},
): Promise<Harness> => {
  let harness!: Harness;
  await jest.isolateModulesAsync(async () => {
    // Keep the module's real helpers and override only the config values.
    // Replacing the whole module drops functions like `isInformationalXError`,
    // and the caller here catches its own errors — so a missing helper shows up
    // as a silently skipped write rather than a failure pointing at the mock.
    jest.doMock('../profile.constants', () => ({
      ...jest.requireActual('../profile.constants'),
      ...BASE_CONSTANTS,
      ...(opts.constants || {}),
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

    const row: any = {
      address: ADDRESS,
      x_username: 'poster',
      x_user_id: null,
      x_lookup_failure_count: 0,
      qualified_posts_count: 0,
      status: 'pending',
      tx_hash: null,
      next_retry_at: null,
      last_x_api_scan_at: null,
      ...rowOverride,
    };

    const postingRewardRepository: any = {
      findOne: jest.fn(async () => row),
      save: jest.fn(async (v: any) => Object.assign(row, v)),
      update: jest.fn(async () => ({ affected: 1 })),
      create: jest.fn(),
      find: jest.fn(async () => []),
    };
    const ledgerRepo: any = {
      find: jest.fn(async () => []),
      update: jest.fn(),
      count: jest.fn(async () => opts.ledgerDue ?? 0),
    };
    const streakRepo: any = {
      find: jest.fn(async () => []),
      update: jest.fn(),
      count: jest.fn(async () => opts.streakDue ?? 0),
      createQueryBuilder: jest.fn(() => {
        const qb: any = {
          select: () => qb,
          addSelect: () => qb,
          where: () => qb,
          andWhere: () => qb,
          getRawOne: async () => ({ count: '0', aettos: '0' }),
        };
        return qb;
      }),
    };

    const getToken = jest.fn(async () =>
      opts.token === undefined ? 'token' : opts.token,
    );
    const xRead = opts.xRead || jest.fn(async () => xResponse(200, {}));
    const recordAttempt = jest.fn().mockResolvedValue(undefined);

    const service = new ProfileXPostingRewardService(
      postingRewardRepository,
      {
        findOne: jest.fn(async () => ({
          address: ADDRESS,
          links: { x: opts.linkedX === undefined ? 'poster' : opts.linkedX },
        })),
      } as any,
      {} as any,
      { sdk: { spend: jest.fn() } } as any,
      { enqueueSpend: jest.fn(), getRewardAccount: jest.fn() } as any,
      {
        getXAppAccessToken: getToken,
        fetchXReadWithAuthFallback: xRead,
      } as any,
      ledgerRepo,
      streakRepo,
      { record: recordAttempt } as any,
    );

    harness = { service, row, xRead, getToken, recordAttempt };
  });
  return harness;
};

/** Stub the scan so a settle-pass test is only about the settle pass. */
const settleOnly = (service: any) => {
  jest.spyOn(service, 'claimDailyScanSlot').mockResolvedValue(false as never);
  return jest
    .spyOn(service, 'runPayouts')
    .mockResolvedValue(undefined as never);
};

describe('X lookup failures are attributed to the right side', () => {
  afterEach(() => jest.clearAllMocks());

  it('records a transient error and spends no strike when no X app token can be obtained', async () => {
    const h = await build({}, { token: null });

    await (h.service as any).processAddressInternal(ADDRESS);

    expect(h.row.error).toBe('x_lookup_unavailable');
    expect(Number(h.row.x_lookup_failure_count)).toBe(0);
    // We never asked X anything, so no lookup budget was spent either.
    expect(h.xRead).not.toHaveBeenCalled();
  });

  it('spends no strike when X answers 503', async () => {
    const h = await build(
      {},
      { xRead: jest.fn(async () => xResponse(503, {})) },
    );

    await (h.service as any).processAddressInternal(ADDRESS);

    expect(h.row.error).toBe('x_lookup_unavailable');
    expect(Number(h.row.x_lookup_failure_count)).toBe(0);
  });

  it('spends no strike when X answers 429', async () => {
    const h = await build(
      { x_lookup_failure_count: 4 },
      { xRead: jest.fn(async () => xResponse(429, {})) },
    );

    await (h.service as any).processAddressInternal(ADDRESS);

    // One short of the block threshold, and it must stay there: an X rate
    // limit is not evidence about the user's handle.
    expect(Number(h.row.x_lookup_failure_count)).toBe(4);
    expect(h.row.error).toBe('x_lookup_unavailable');
  });

  it('still strikes when X authoritatively resolves the handle to nothing', async () => {
    // 200 carrying `errors` and no `data.id` is how X reports a missing handle.
    const h = await build(
      { x_lookup_failure_count: 2 },
      {
        xRead: jest.fn(async () =>
          xResponse(200, { errors: [{ title: 'Not Found Error' }] }),
        ),
      },
    );

    await (h.service as any).processAddressInternal(ADDRESS);

    expect(h.row.error).toBe('x_user_lookup_failed');
    expect(Number(h.row.x_lookup_failure_count)).toBe(3);
  });

  it('still strikes on a 404', async () => {
    const h = await build(
      { x_lookup_failure_count: 0 },
      { xRead: jest.fn(async () => xResponse(404, {})) },
    );

    await (h.service as any).processAddressInternal(ADDRESS);

    expect(h.row.error).toBe('x_user_lookup_failed');
    expect(Number(h.row.x_lookup_failure_count)).toBe(1);
  });
});

describe('the unauthenticated refresh only settles wallets that are owed something', () => {
  afterEach(() => jest.clearAllMocks());

  it('skips the payout pass entirely for a wallet with nothing due', async () => {
    const h = await build({
      status: 'pending',
      qualified_posts_count: 0,
      tx_hash: null,
    });
    const runPayouts = settleOnly(h.service);

    await (h.service as any).refreshInBackgroundIfDue(ADDRESS);

    expect(runPayouts).not.toHaveBeenCalled();
  });

  it('runs the payout pass when the onboarding reward is earned and unpaid', async () => {
    const h = await build({
      status: 'pending',
      qualified_posts_count: 1,
      tx_hash: null,
    });
    const runPayouts = settleOnly(h.service);

    await (h.service as any).refreshInBackgroundIfDue(ADDRESS);

    expect(runPayouts).toHaveBeenCalledTimes(1);
  });

  it('runs the payout pass when a per-post reward row is due', async () => {
    const h = await build(
      { status: 'paid', qualified_posts_count: 0 },
      { ledgerDue: 2 },
    );
    const runPayouts = settleOnly(h.service);

    await (h.service as any).refreshInBackgroundIfDue(ADDRESS);

    expect(runPayouts).toHaveBeenCalledTimes(1);
  });

  it('runs the payout pass when a streak bonus row is due', async () => {
    const h = await build(
      { status: 'paid', qualified_posts_count: 0 },
      { streakDue: 1 },
    );
    const runPayouts = settleOnly(h.service);

    await (h.service as any).refreshInBackgroundIfDue(ADDRESS);

    expect(runPayouts).toHaveBeenCalledTimes(1);
  });

  it('runs the payout pass for a broadcast whose confirmation write failed', async () => {
    const h = await build({
      status: 'failed',
      qualified_posts_count: 0,
      tx_hash: 'th_2iBPH7HaU3zbqTzJCanLDvQiJU4EV6AqgFMbkTnkeTgGh2ELdz',
    });
    const runPayouts = settleOnly(h.service);

    await (h.service as any).refreshInBackgroundIfDue(ADDRESS);

    expect(runPayouts).toHaveBeenCalledTimes(1);
  });

  it('files the page-load scan in the attempt history, tagged to that source', async () => {
    // This is now the main way checks happen, so a history that only records
    // button presses cannot show a failure which only occurs on page load.
    const h = await build({ status: 'paid', qualified_posts_count: 1 });
    settleOnly(h.service);
    // Everything between the gate and the scan is exercised elsewhere; what is
    // under test here is that a completed scan gets filed.
    jest
      .spyOn(h.service as any, 'prepareCheckCandidate')
      .mockResolvedValue({ status: 'paid', last_x_api_scan_at: null } as never);
    jest
      .spyOn(h.service as any, 'claimDailyScanSlot')
      .mockResolvedValue(true as never);
    jest
      .spyOn(h.service as any, 'processAddressWithGuard')
      .mockResolvedValue(undefined as never);

    await (h.service as any).refreshInBackgroundIfDue(ADDRESS);

    expect(h.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ address: ADDRESS, source: 'page_refresh' }),
    );
  });

  it('gives a thrown page-load scan an error CODE, not just free text', async () => {
    // The dashboard groups and indexes on `error_code`. Filing null there would
    // keep these failures off every "what is failing lately" view and leave the
    // fault discoverable only by reading `detail` row by row.
    const h = await build({ status: 'paid', qualified_posts_count: 1 });
    settleOnly(h.service);
    jest
      .spyOn(h.service as any, 'prepareCheckCandidate')
      .mockResolvedValue({ status: 'paid', last_x_api_scan_at: null } as never);
    jest
      .spyOn(h.service as any, 'claimDailyScanSlot')
      .mockResolvedValue(true as never);
    jest
      .spyOn(h.service as any, 'processAddressWithGuard')
      .mockRejectedValue(new Error('middleware exploded') as never);
    jest
      .spyOn(h.service as any, 'releaseDailyScanSlot')
      .mockResolvedValue(undefined as never);

    await (h.service as any).refreshInBackgroundIfDue(ADDRESS);

    expect(h.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        address: ADDRESS,
        source: 'page_refresh',
        outcome: 'failed',
        // Same code the signed path uses for the same fault, so the two
        // aggregate together instead of looking like different problems.
        errorCode: 'recheck_failed',
        detail: 'middleware exploded',
      }),
    );
  });

  it('does not settle while the failure backoff is still running', async () => {
    const h = await build({
      status: 'failed',
      qualified_posts_count: 1,
      tx_hash: null,
      next_retry_at: new Date(Date.now() + 60 * 60 * 1000),
    });
    const runPayouts = settleOnly(h.service);

    await (h.service as any).refreshInBackgroundIfDue(ADDRESS);

    expect(runPayouts).not.toHaveBeenCalled();
  });
});

import { BclAffiliationAnalyticsService } from './bcl-affiliation-analytics.service';

/**
 * The constructor takes seven positional repositories, and each test cares
 * about one or two of them. Naming them here means adding a repository is one
 * edit rather than a padding line in every test, and a test that wants
 * `postingRewardRepo` says so instead of counting `{} as any` placeholders.
 */
function makeService(
  overrides: Partial<{
    invitationRepo: any;
    txRepo: any;
    profileXInviteRepo: any;
    postingRewardRepo: any;
    postRewardLedgerRepo: any;
    streakBonusRepo: any;
    inviteMilestoneRepo: any;
  }> = {},
) {
  const stub = () => ({}) as any;
  return new BclAffiliationAnalyticsService(
    overrides.invitationRepo ?? stub(),
    overrides.txRepo ?? stub(),
    overrides.profileXInviteRepo ?? stub(),
    overrides.postingRewardRepo ?? stub(),
    overrides.postRewardLedgerRepo ?? stub(),
    overrides.streakBonusRepo ?? stub(),
    overrides.inviteMilestoneRepo ?? stub(),
  );
}

describe('BclAffiliationAnalyticsService', () => {
  it('runs x verification queries in parallel with dashboard totals', async () => {
    const service = makeService();
    let releaseFirstBatch: (() => void) | null = null;
    const firstBatchGate = new Promise<void>((resolve) => {
      releaseFirstBatch = resolve;
    });

    jest.spyOn(service as any, 'parseDateRange').mockReturnValue({
      startDate: new Date('2026-03-01T00:00:00.000Z'),
      endDate: new Date('2026-03-04T00:00:00.000Z'),
    });
    jest
      .spyOn(service as any, 'getDailyRegisteredCounts')
      .mockImplementation(async () => {
        await firstBatchGate;
        return {};
      });
    jest
      .spyOn(service as any, 'getDailyStatusCounts')
      .mockImplementation(async () => {
        await firstBatchGate;
        return {};
      });
    jest
      .spyOn(service as any, 'getDailyRegisteredAmount')
      .mockImplementation(async () => {
        await firstBatchGate;
        return {};
      });
    const getXVerificationData = jest.spyOn(
      service as any,
      'getXVerificationData',
    );
    getXVerificationData.mockResolvedValue({
      series: [],
      summary: { total_verified_users: 0 },
      queryMs: 1,
    });
    jest.spyOn(service as any, 'getTotals').mockResolvedValue({
      total_registered: 0,
      total_redeemed: 0,
      total_revoked: 0,
    });
    jest.spyOn(service as any, 'getUniques').mockResolvedValue({
      unique_inviters: 0,
      unique_invitees: 0,
      unique_redeemers: 0,
    });
    jest.spyOn(service as any, 'getAmountTotals').mockResolvedValue({
      total_amount_ae_registered: 0,
    });
    jest.spyOn(service as any, 'fillDailySeries').mockReturnValue([]);

    const dashboardPromise = service.getDashboardData({});
    await Promise.resolve();

    expect(getXVerificationData).toHaveBeenCalledTimes(1);

    releaseFirstBatch?.();
    await dashboardPromise;
  });

  it('counts verifications from the rewards table, not from raw link arguments', async () => {
    // The bug: this read `t.raw->'arguments'` and matched only
    // `function = 'link'`. The pipeline records a verification four ways —
    // `link` (addr at arg 0), `link_principal` (signer at arg 1, provider one
    // index further along), and a contract-LOGS fallback with no `arguments`
    // at all. So the dashboard reported 0 while the onboarding funnel, reading
    // the table below, reported real linked accounts.
    const groupBy = jest.fn().mockReturnThis();
    const orderBy = jest.fn().mockReturnThis();
    const where = jest.fn().mockReturnThis();
    const andWhere = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const postingRewardRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        select,
        addSelect: jest.fn().mockReturnThis(),
        where,
        andWhere,
        groupBy,
        orderBy,
        getRawMany: jest.fn().mockResolvedValue([
          { date: '2026-03-01', count: 2 },
          { date: '2026-03-02', count: 1 },
        ]),
      }),
    } as any;
    const txRepo = {
      createQueryBuilder: jest.fn(() => {
        throw new Error('must not read raw link transactions');
      }),
    } as any;

    const service = makeService({ txRepo, postingRewardRepo });

    const result = await (service as any).getDailyXVerifications(
      new Date('2026-03-01T00:00:00.000Z'),
      new Date('2026-03-04T00:00:00.000Z'),
    );

    expect(result).toEqual({ '2026-03-01': 2, '2026-03-02': 1 });
    // Dated by the link event, and only rows that actually carry a handle.
    expect(where).toHaveBeenCalledWith('r.verified_at IS NOT NULL');
    expect(andWhere).toHaveBeenCalledWith('r.x_username IS NOT NULL');
    // Never again derived from the transaction argument shape.
    expect(txRepo.createQueryBuilder).not.toHaveBeenCalled();
    const sql = JSON.stringify([...select.mock.calls, ...groupBy.mock.calls]);
    expect(sql).not.toContain('arguments');
  });

  it('totals distinct verified addresses from the same source as the series', async () => {
    // Summary and chart disagreed before, because only one of them could match
    // a row. Both now read the same table, so they cannot drift apart.
    const postingRewardRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ count: 3 }),
      }),
    } as any;

    const service = makeService({ postingRewardRepo });

    await expect(
      (service as any).getTotalVerifiedUsers(
        new Date('2026-03-01T00:00:00.000Z'),
        new Date('2026-03-04T00:00:00.000Z'),
      ),
    ).resolves.toBe(3);
  });

  it('builds an onboarding funnel of strictly narrowing stages', async () => {
    const service = makeService();

    jest.spyOn(service as any, 'parseDateRange').mockReturnValue({
      startDate: new Date('2026-03-01T00:00:00.000Z'),
      endDate: new Date('2026-03-03T00:00:00.000Z'),
    });
    jest.spyOn(service as any, 'getOnboardingCohortCounts').mockResolvedValue({
      linked_x: 10,
      scanned: 6,
      follower_eligible: 4,
      qualifying_post: 3,
      onboarding_paid: 2,
    });
    jest
      .spyOn(service as any, 'getOnboardingPerPostEarners')
      .mockResolvedValue(1);
    jest
      .spyOn(service as any, 'getOnboardingStreakEarners')
      .mockResolvedValue(0);
    jest
      .spyOn(service as any, 'getOnboardingBlockers')
      .mockResolvedValue([{ reason: 'never_checked', count: 4 }]);
    jest
      .spyOn(service as any, 'getOnboardingTierDistribution')
      .mockResolvedValue([{ tier_index: 0, count: 4 }]);
    jest
      .spyOn(service as any, 'getOnboardingPaidAettos')
      .mockResolvedValue(5e18);
    jest
      .spyOn(service as any, 'getDailyXVerifications')
      .mockResolvedValue({ '2026-03-01': 7 });
    jest
      .spyOn(service as any, 'getDailyPerPostPaidCounts')
      .mockResolvedValue({ '2026-03-02': 1 });

    const result = await service.getXOnboardingData({});

    // Per-post and streak rewards are a separate path, not deeper funnel
    // stages, so they stay out of the funnel and cannot widen it.
    expect(result.funnel.map((s) => s.key)).toEqual([
      'linked_x',
      'scanned',
      'follower_eligible',
      'qualifying_post',
      'onboarding_paid',
    ]);
    expect(result.funnel.map((s) => s.count)).toEqual([10, 6, 4, 3, 2]);
    const counts = result.funnel.map((s) => s.count);
    counts.forEach((count, i) => {
      if (i > 0) expect(count).toBeLessThanOrEqual(counts[i - 1]);
    });
    expect(result.funnel.every((s) => s.rate <= 1)).toBe(true);
    expect(result.summary.per_post_earning).toBe(1);
    expect(result.summary.streak_bonus_paid).toBe(0);
    expect(result.funnel[0].rate).toBe(1);
    expect(result.summary.conversion_rate).toBeCloseTo(0.2);
    expect(result.summary.total_paid_ae).toBeCloseTo(5);
    expect(result.series).toEqual([
      { date: '2026-03-01', linked: 7, per_post_paid: 0 },
      { date: '2026-03-02', linked: 0, per_post_paid: 1 },
    ]);
  });

  it('nests the cohort stage predicates so the funnel cannot widen', () => {
    const reached = (BclAffiliationAnalyticsService as any).ONBOARDING_REACHED;

    // Each predicate must contain the one below it, so every row counted at a
    // deeper stage is also counted at every shallower one. A row can be `paid`
    // while its scan fields were reset by a re-link, which is exactly the case
    // that made plain per-stage predicates report a widening funnel.
    expect(reached.post).toContain(reached.paid);
    expect(reached.eligible).toContain('qualified_posts_count > 0');
    expect(reached.eligible).toContain(reached.paid);
    expect(reached.scanned).toContain('follower_count >= :minFollowers');
    expect(reached.scanned).toContain(reached.paid);
    expect(reached.scanned).toContain('last_x_api_scan_at IS NOT NULL');
  });

  it('does not file an informational notice as a blocker', async () => {
    const select = jest.fn().mockReturnThis();
    const postingRewardRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        select,
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      }),
    } as any;

    const service = makeService({ postingRewardRepo });

    await (service as any).getOnboardingBlockers(
      new Date('2026-03-01T00:00:00.000Z'),
      new Date('2026-03-02T00:00:00.000Z'),
    );

    // `x_posts_scan_truncated` is written on a SUCCESSFUL scan that hit the
    // post limit. Counting it as a blocker buries the real payout bottleneck.
    const reasonSql = String(select.mock.calls[0]?.[0] ?? '');
    expect(reasonSql).toContain("NOT IN ('x_posts_scan_truncated')");
    expect(reasonSql).toContain('never_checked');
    expect(reasonSql).toContain('no_qualifying_post');
  });

  it('reports a zero conversion rate instead of dividing by zero', async () => {
    const service = makeService();

    jest.spyOn(service as any, 'parseDateRange').mockReturnValue({
      startDate: new Date('2026-03-01T00:00:00.000Z'),
      endDate: new Date('2026-03-02T00:00:00.000Z'),
    });
    jest.spyOn(service as any, 'getOnboardingCohortCounts').mockResolvedValue({
      linked_x: 0,
      scanned: 0,
      follower_eligible: 0,
      qualifying_post: 0,
      onboarding_paid: 0,
    });
    jest
      .spyOn(service as any, 'getOnboardingPerPostEarners')
      .mockResolvedValue(0);
    jest
      .spyOn(service as any, 'getOnboardingStreakEarners')
      .mockResolvedValue(0);
    jest.spyOn(service as any, 'getOnboardingBlockers').mockResolvedValue([]);
    jest
      .spyOn(service as any, 'getOnboardingTierDistribution')
      .mockResolvedValue([]);
    jest.spyOn(service as any, 'getOnboardingPaidAettos').mockResolvedValue(0);
    jest.spyOn(service as any, 'getDailyXVerifications').mockResolvedValue({});
    jest
      .spyOn(service as any, 'getDailyPerPostPaidCounts')
      .mockResolvedValue({});

    const result = await service.getXOnboardingData({});

    expect(result.summary.conversion_rate).toBe(0);
    expect(result.funnel.every((s) => s.rate === 0)).toBe(true);
  });

  describe('getXExplorerData', () => {
    /** Chainable query-builder stub: every method returns itself. */
    const qb = (rows: any[]) => {
      const builder: any = new Proxy(
        { getMany: async () => rows },
        {
          get: (target, prop) =>
            prop in target ? (target as any)[prop] : () => builder,
        },
      );
      return { createQueryBuilder: () => builder } as any;
    };

    const rewardRow = (over: Partial<any> = {}) => ({
      address: 'ak_inviter',
      x_username: 'someone',
      verified_at: new Date('2026-06-24T00:00:00.000Z'),
      referral_code: 'abc123',
      follower_count: 0,
      follower_tier_index: 0,
      qualified_posts_count: 0,
      current_streak_days: 0,
      status: 'pending',
      error: null,
      last_x_api_scan_at: null,
      created_at: new Date('2026-06-24T00:00:00.000Z'),
      ...over,
    });

    const run = (over: { reward?: any; streak?: any[] } = {}) =>
      makeService({
        postingRewardRepo: qb([rewardRow(over.reward)]),
        profileXInviteRepo: qb([]),
        postRewardLedgerRepo: qb([]),
        streakBonusRepo: qb(over.streak ?? []),
        inviteMilestoneRepo: qb([]),
      }).getXExplorerData({});

    it('says why a wallet is not eligible, with the number it failed on', async () => {
      // "below_min_followers" alone sends the reader to the source to find out
      // what the threshold even is. The verdict has to carry both sides of the
      // comparison, and the raw code alongside it.
      const result = await run({
        reward: { follower_count: 0, error: 'below_min_followers' },
      });

      const { eligibility } = result.users[0];
      expect(eligibility.eligible).toBe(false);
      expect(eligibility.label).toMatch(/not eligible/i);
      expect(eligibility.label).toMatch(/followers/i);
      expect(eligibility.detail).toContain('0 followers');
      expect(eligibility.detail).toContain(String(result.min_followers));
      expect(eligibility.code).toBe('below_min_followers');
    });

    it('still reports a blocker on a wallet that was paid earlier', async () => {
      // Caught in review. `status` and `error` describe different moments: the
      // onboarding payout sets status='paid' once and it stays, while every
      // later scan overwrites `error` on the same row. Reading paid as
      // "currently fine" hid exactly the wallets that stopped qualifying.
      const result = await run({
        reward: {
          status: 'paid',
          follower_count: 0,
          error: 'below_min_followers',
          tx_hash: 'th_2aBcDeFgHiJkLmNoPqRsTuVwXyZ',
        },
      });

      const { eligibility } = result.users[0];
      expect(eligibility.eligible).toBe(false);
      expect(eligibility.code).toBe('below_min_followers');
      expect(eligibility.detail).toContain('was paid earlier');
      expect(result.summary.eligible_users).toBe(0);
    });

    it('counts the onboarding payout, which lives on the reward row not the ledger', async () => {
      // Caught in review. profile_x_post_reward_ledger only ever receives
      // reward_kind 'per_post'; the onboarding send writes tx_hash and status
      // straight onto profile_x_posting_rewards. Reading only the ledger
      // dropped every onboarding payout from the list, links and totals.
      const result = await run({
        reward: {
          status: 'paid',
          follower_count: 500,
          error: null,
          tx_hash: 'th_2aBcDeFgHiJkLmNoPqRsTuVwXyZ',
        },
      });

      const onboarding = result.users[0].payouts.find(
        (p) => p.kind === 'onboarding',
      );
      expect(onboarding).toBeDefined();
      expect(onboarding?.status).toBe('paid');
      expect(onboarding?.explorer_url).toBe(
        `${result.explorer_base_url}/transactions/th_2aBcDeFgHiJkLmNoPqRsTuVwXyZ`,
      );
      expect(result.summary.payouts_paid).toBe(1);
    });

    it('does not invent an onboarding payout for a wallet that never had one', async () => {
      const result = await run({
        reward: { status: 'pending', error: null, tx_hash: null },
      });

      expect(result.users[0].payouts).toEqual([]);
      expect(result.users[0].total_ae_paid).toBe('0');
    });

    it('does not link the onboarding in-progress sentinel', async () => {
      const result = await run({
        reward: {
          status: 'pending',
          error: null,
          tx_hash: '__posting_reward_payout_in_progress__',
        },
      });

      const onboarding = result.users[0].payouts[0];
      expect(onboarding.kind).toBe('onboarding');
      expect(onboarding.status).toBe('pending');
      expect(onboarding.tx_hash).toBeNull();
      expect(onboarding.explorer_url).toBeNull();
      expect(result.users[0].total_ae_paid).toBe('0');
    });

    it('keeps a failed onboarding send visible after a later scan', async () => {
      // Caught in review. The failed path writes tx_hash: null and
      // status: 'failed', and the next scan overwrites `error`. Detecting the
      // failure from the error code lost it entirely at that point: a wallet
      // that earned but was never paid looked like it had never been tried.
      const result = await run({
        reward: {
          status: 'failed',
          tx_hash: null,
          // The send failed long ago; this is a later scan's eligibility code.
          error: 'below_min_followers',
          follower_count: 0,
        },
      });

      const onboarding = result.users[0].payouts.find(
        (p) => p.kind === 'onboarding',
      );
      expect(onboarding).toBeDefined();
      expect(onboarding?.status).toBe('failed');
      expect(result.summary.payouts_failed).toBe(1);
    });

    it('does not show a later scan error as the payout error', async () => {
      // Caught in review. `error` is shared between payout state and
      // eligibility codes. Showing `below_min_followers` under a settled
      // payout reads as "the send failed" — a lie about money that arrived.
      const result = await run({
        reward: {
          status: 'paid',
          tx_hash: 'th_2aBcDeFgHiJkLmNoPqRsTuVwXyZ',
          error: 'below_min_followers',
          follower_count: 0,
        },
      });

      const onboarding = result.users[0].payouts.find(
        (p) => p.kind === 'onboarding',
      );
      expect(onboarding?.status).toBe('paid');
      expect(onboarding?.error).toBeNull();
      // The blocker is still reported — as eligibility, where it belongs.
      expect(result.users[0].eligibility.code).toBe('below_min_followers');
    });

    it('does not call a never-scanned wallet eligible', async () => {
      // Nothing evaluates these rewards on a schedule -- only the user pressing
      // "Check rewards" triggers a scan. A wallet that linked X and never came
      // back has a null scan timestamp and a null error, and reporting that as
      // "Eligible" claims an evaluation that never happened. Seen live on
      // production months after the link.
      const result = await run({
        reward: {
          status: 'pending',
          error: null,
          follower_count: null,
          last_x_api_scan_at: null,
        },
      });

      const { eligibility } = result.users[0];
      expect(eligibility.eligible).toBe(false);
      expect(eligibility.label).toMatch(/never scanned/i);
      expect(result.summary.eligible_users).toBe(0);
    });

    it('does not treat a truncated scan as a failure', async () => {
      // A truncated scan is a COMPLETED check that hit the per-check post
      // limit. Filing it as "not eligible" is a bug this pipeline has already
      // had twice, in two other places.
      const result = await run({
        reward: { follower_count: 500, error: 'x_posts_scan_truncated' },
      });

      expect(result.users[0].eligibility.eligible).toBe(true);
      expect(result.users[0].eligibility.label).not.toMatch(/not eligible/i);
    });

    it('never links a payout-in-progress sentinel to the block explorer', async () => {
      // The payout services park sentinel strings in tx_hash while a send is
      // in flight. Linking one produces a confident 404 on aescan, which reads
      // as "the chain lost our money" rather than "not sent yet".
      const result = await run({
        streak: [
          {
            address: 'ak_inviter',
            amount_aettos: '50000000000000000000',
            status: 'pending',
            tx_hash: '__streak_bonus_payout_in_progress__',
            streak_length: 10,
            streak_completed_day: '2026-07-01',
            error: null,
            created_at: new Date('2026-07-01T00:00:00.000Z'),
          },
        ],
      });

      const payout = result.users[0].payouts[0];
      expect(payout.kind).toBe('streak_bonus');
      expect(payout.tx_hash).toBeNull();
      expect(payout.explorer_url).toBeNull();
      // Unsettled money is not money paid.
      expect(result.users[0].total_ae_paid).toBe('0');
      expect(result.summary.payouts_paid).toBe(0);
    });

    it('links a settled payout to its real transaction and counts the AE', async () => {
      const result = await run({
        streak: [
          {
            address: 'ak_inviter',
            // 50 AE in aettos is past Number.MAX_SAFE_INTEGER, so this also
            // pins that the amount survives without being rounded.
            amount_aettos: '50000000000000000000',
            status: 'paid',
            tx_hash: 'th_2aBcDeFgHiJkLmNoPqRsTuVwXyZ',
            streak_length: 10,
            streak_completed_day: '2026-07-01',
            error: null,
            created_at: new Date('2026-07-01T00:00:00.000Z'),
          },
        ],
      });

      const payout = result.users[0].payouts[0];
      expect(payout.amount_ae).toBe('50');
      expect(payout.explorer_url).toBe(
        `${result.explorer_base_url}/transactions/th_2aBcDeFgHiJkLmNoPqRsTuVwXyZ`,
      );
      expect(result.users[0].total_ae_paid).toBe('50');
      expect(result.summary.total_ae_paid).toBe('50');
      expect(result.summary.payouts_paid).toBe(1);
    });
  });
});

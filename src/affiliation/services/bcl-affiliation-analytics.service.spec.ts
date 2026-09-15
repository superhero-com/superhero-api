import { BclAffiliationAnalyticsService } from './bcl-affiliation-analytics.service';

describe('BclAffiliationAnalyticsService', () => {
  it('runs x verification queries in parallel with dashboard totals', async () => {
    const service = new BclAffiliationAnalyticsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
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

  it('counts each linked address once on their first verification day in range', async () => {
    const groupBy = jest.fn().mockReturnThis();
    const orderBy = jest.fn().mockReturnThis();
    const andWhere = jest.fn().mockReturnThis();
    const addSelect = jest.fn().mockReturnThis();
    const txRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect,
        where: jest.fn().mockReturnThis(),
        andWhere,
        groupBy,
        orderBy,
        getRawMany: jest.fn().mockResolvedValue([
          { linked_address: 'ak_a', date: '2026-03-01' },
          { linked_address: 'ak_b', date: '2026-03-01' },
          { linked_address: 'ak_c', date: '2026-03-02' },
        ]),
      }),
    } as any;

    const service = new BclAffiliationAnalyticsService(
      {} as any,
      txRepo,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await (service as any).getDailyXVerifications(
      new Date('2026-03-01T00:00:00.000Z'),
      new Date('2026-03-04T00:00:00.000Z'),
    );

    expect(addSelect).toHaveBeenCalledWith(
      expect.stringContaining('MIN('),
      'date',
    );
    expect(groupBy).toHaveBeenCalledWith("t.raw->'arguments'->0->>'value'");
    expect(result).toEqual({
      '2026-03-01': 2,
      '2026-03-02': 1,
    });

    // Regression: the day bucket used to divide by 1e6, which buckets a
    // millisecond timestamp into 1970 and matches no day in the series.
    const bucketSelect = addSelect.mock.calls.find(([sql]) =>
      String(sql).includes('date_trunc'),
    );
    expect(bucketSelect?.[0]).toContain('/ 1000.0');
    expect(bucketSelect?.[0]).not.toContain('1000000');
  });

  it('brackets millisecond micro_time values', () => {
    const service = new BclAffiliationAnalyticsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const startDate = new Date('2026-03-01T00:00:00.000Z');
    const endDate = new Date('2026-03-04T00:00:00.000Z');

    const { startMicro, endMicro } = (service as any).getMicroTimeRange(
      startDate,
      endDate,
    );

    // `txs.micro_time` is written straight from the middleware, which returns
    // 13-digit epoch MILLISECONDS despite the column name. Bounds scaled to
    // microseconds are ~1000x too large, so the predicate never matched and
    // both X verification queries returned zero for every range.
    const storedMicroTime = BigInt(
      new Date('2026-03-02T12:00:00.000Z').getTime(),
    );
    expect(storedMicroTime.toString()).toHaveLength(13);
    expect(BigInt(startMicro)).toBe(BigInt(startDate.getTime()));
    expect(BigInt(endMicro)).toBe(BigInt(endDate.getTime()));
    expect(storedMicroTime >= BigInt(startMicro)).toBe(true);
    expect(storedMicroTime < BigInt(endMicro)).toBe(true);
  });

  it('builds an onboarding funnel of strictly narrowing stages', async () => {
    const service = new BclAffiliationAnalyticsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

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

    const service = new BclAffiliationAnalyticsService(
      {} as any,
      {} as any,
      {} as any,
      postingRewardRepo,
      {} as any,
      {} as any,
    );

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
    const service = new BclAffiliationAnalyticsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

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
});

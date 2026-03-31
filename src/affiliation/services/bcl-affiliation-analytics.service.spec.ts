import { BclAffiliationAnalyticsService } from './bcl-affiliation-analytics.service';

describe('BclAffiliationAnalyticsService', () => {
  it('runs x verification queries in parallel with dashboard totals', async () => {
    const service = new BclAffiliationAnalyticsService(
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

  it('counts each caller once on their first verification day in range', async () => {
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
          { caller_id: 'ak_a', date: '2026-03-01' },
          { caller_id: 'ak_b', date: '2026-03-01' },
          { caller_id: 'ak_c', date: '2026-03-02' },
        ]),
      }),
    } as any;

    const service = new BclAffiliationAnalyticsService(
      {} as any,
      txRepo,
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
    expect(groupBy).toHaveBeenCalledWith('t.caller_id');
    expect(result).toEqual({
      '2026-03-01': 2,
      '2026-03-02': 1,
    });
  });
});

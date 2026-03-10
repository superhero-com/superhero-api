import { BclAffiliationAnalyticsService } from './bcl-affiliation-analytics.service';

describe('BclAffiliationAnalyticsService', () => {
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

import { BadRequestException } from '@nestjs/common';
import { AnalyticTokensController } from './analytics-tokens.controller';

describe('AnalyticTokensController', () => {
  let controller: AnalyticTokensController;
  let queryBuilder: {
    select: jest.Mock;
    addSelect: jest.Mock;
    groupBy: jest.Mock;
    orderBy: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    getRawMany: jest.Mock;
  };

  beforeEach(() => {
    queryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    const tokensRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };

    controller = new AnalyticTokensController(
      tokensRepository as any,
      {} as any,
      {} as any,
    );
  });

  describe('listDailyCreatedTokensCount', () => {
    it('rejects an invalid start_date', async () => {
      await expect(
        controller.listDailyCreatedTokensCount('not-a-date', undefined),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an invalid end_date', async () => {
      await expect(
        controller.listDailyCreatedTokensCount(undefined, 'not-a-date'),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts valid dates', async () => {
      await expect(
        controller.listDailyCreatedTokensCount('2026-01-01', '2026-01-31'),
      ).resolves.toEqual([]);
    });
  });
});

import { BadRequestException } from '@nestjs/common';
import { AnalyticsTransactionsController } from './analytics-transactions.controller';

describe('AnalyticsTransactionsController', () => {
  let controller: AnalyticsTransactionsController;
  let queryBuilder: {
    andWhere: jest.Mock;
    select: jest.Mock;
    getRawOne: jest.Mock;
  };
  let transactionsRepository: { createQueryBuilder: jest.Mock };
  let tokensRepository: { find: jest.Mock };

  beforeEach(() => {
    queryBuilder = {
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ total_users: '7' }),
    };
    transactionsRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    tokensRepository = { find: jest.fn().mockResolvedValue([]) };

    controller = new AnalyticsTransactionsController(
      transactionsRepository as any,
      tokensRepository as any,
      {} as any,
      {} as any,
    );
  });

  describe('totalUniqueUsers', () => {
    it('rejects more than the max allowed token_sale_addresses', async () => {
      const tooMany = Array.from({ length: 101 }, (_, i) => `ct_${i}`);

      await expect(controller.totalUniqueUsers(tooMany)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('filters on the resolved sale addresses when the tokens exist', async () => {
      tokensRepository.find.mockResolvedValue([
        { sale_address: 'ct_1' },
        { sale_address: 'ct_2' },
      ]);

      await expect(
        controller.totalUniqueUsers(['ct_1', 'ct_2']),
      ).resolves.toEqual({ total_users: 7 });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('IN (:...uniqueTokenSaleAddresses)'),
        { uniqueTokenSaleAddresses: ['ct_1', 'ct_2'] },
      );
    });

    // An empty list would expand to `IN ()`; the query must never be built.
    it('returns zero without querying when no address resolves to a token', async () => {
      tokensRepository.find.mockResolvedValue([]);

      await expect(controller.totalUniqueUsers(['ct_nope'])).resolves.toEqual({
        total_users: 0,
      });
      expect(queryBuilder.andWhere).not.toHaveBeenCalled();
      expect(queryBuilder.getRawOne).not.toHaveBeenCalled();
    });

    it('counts across the whole system when no filter is given', async () => {
      await expect(controller.totalUniqueUsers()).resolves.toEqual({
        total_users: 7,
      });
      expect(queryBuilder.andWhere).not.toHaveBeenCalled();
    });
  });
});

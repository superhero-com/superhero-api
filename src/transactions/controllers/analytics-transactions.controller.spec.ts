import { BadRequestException } from '@nestjs/common';
import moment from 'moment';
import { AnalyticsTransactionsController } from './analytics-transactions.controller';

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('AnalyticsTransactionsController', () => {
  let controller: AnalyticsTransactionsController;
  let queryBuilder: {
    andWhere: jest.Mock;
    select: jest.Mock;
    getRawOne: jest.Mock;
  };
  let transactionsRepository: {
    createQueryBuilder: jest.Mock;
    query: jest.Mock;
  };
  let tokensRepository: { find: jest.Mock };

  beforeEach(() => {
    queryBuilder = {
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ total_users: '7' }),
    };
    transactionsRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      query: jest.fn(),
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

  describe('listDailyMarketCapSum', () => {
    let pending: Array<() => void>;
    let inFlight: number;
    let maxInFlight: number;

    // Day queries stay open until releaseRound() or drain() releases them.
    const holdQueries = () => {
      transactionsRepository.query.mockImplementation(() => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) =>
          pending.push(() => {
            inFlight--;
            resolve([{ total: '1' }]);
          }),
        );
      });
    };

    // Releases the queries open now, then lets the freed slots be taken.
    const releaseRound = async () => {
      pending.splice(0).forEach((release) => release());
      await flush();
    };

    const drain = async () => {
      do {
        await releaseRound();
      } while (pending.length);
    };

    beforeEach(() => {
      pending = [];
      inFlight = 0;
      maxInFlight = 0;
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('returns one sum per day, oldest first', async () => {
      transactionsRepository.query.mockImplementation(
        async (_sql: string, [endOfDay]: [Date]) => [
          {
            total: endOfDay.getDate() === 3 ? null : `${endOfDay.getDate()}.5`,
          },
        ],
      );

      await expect(
        controller.listDailyMarketCapSum('2026-01-01', '2026-01-03'),
      ).resolves.toEqual([
        { date: '2026-01-01', sum: 1.5 },
        { date: '2026-01-02', sum: 2.5 },
        { date: '2026-01-03', sum: 0 },
      ]);
      expect(
        transactionsRepository.query.mock.calls.map(([, params]) => params),
      ).toEqual(
        ['2026-01-01', '2026-01-02', '2026-01-03'].map((date) => [
          moment(date).endOf('day').toDate(),
        ]),
      );
    });

    it('returns nothing without querying when the start is after the end', async () => {
      await expect(
        controller.listDailyMarketCapSum('2026-01-05', '2026-01-01'),
      ).resolves.toEqual([]);
      expect(transactionsRepository.query).not.toHaveBeenCalled();
    });

    it('covers at most the last 366 days', async () => {
      transactionsRepository.query.mockResolvedValue([{ total: '1' }]);

      const sums = await controller.listDailyMarketCapSum(
        '2024-01-01',
        '2026-01-01',
      );

      expect(sums).toHaveLength(366);
      expect(sums[0].date).toBe('2025-01-01');
      expect(sums[365].date).toBe('2026-01-01');
    });

    it('runs 20 day queries at once for one request, and no more for several', async () => {
      holdQueries();

      const first = controller.listDailyMarketCapSum(
        '2025-01-01',
        '2025-02-15',
      );
      await flush();
      expect(inFlight).toBe(20);

      const second = controller.listDailyMarketCapSum(
        '2025-06-01',
        '2025-07-15',
      );
      await flush();
      expect(inFlight).toBe(20);

      await drain();
      await expect(first).resolves.toHaveLength(46);
      await expect(second).resolves.toHaveLength(45);
      expect(maxInFlight).toBe(20);
      expect(transactionsRepository.query).toHaveBeenCalledTimes(91);
    });

    it('answers a short request without waiting for a long one to finish', async () => {
      holdQueries();
      let longDone = false;
      let shortDone = false;

      const long = controller.listDailyMarketCapSum('2025-01-01', '2025-04-10');
      long.then(() => {
        longDone = true;
      });
      await flush();
      const short = controller.listDailyMarketCapSum(
        '2025-06-01',
        '2025-06-01',
      );
      short.then(() => {
        shortDone = true;
      });
      await flush();

      await releaseRound();
      await releaseRound();
      expect(shortDone).toBe(true);
      expect(longDone).toBe(false);

      await drain();
      await expect(long).resolves.toHaveLength(100);
      await expect(short).resolves.toHaveLength(1);
    });

    it('shares one load between requests for the same days', async () => {
      holdQueries();

      const first = controller.listDailyMarketCapSum(
        '2026-01-01T03:00:00',
        '2026-01-05',
      );
      const second = controller.listDailyMarketCapSum(
        '2026-01-01T21:00:00',
        '2026-01-05T08:00:00',
        ['ct_ignored'],
      );
      await drain();

      const sums = await first;
      expect(sums).toHaveLength(5);
      await expect(second).resolves.toEqual(sums);
      expect(transactionsRepository.query).toHaveBeenCalledTimes(5);
    });

    it('reuses a finished result for 20 seconds', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      transactionsRepository.query.mockResolvedValue([{ total: '1' }]);

      await controller.listDailyMarketCapSum('2026-01-01', '2026-01-03');
      now.mockReturnValue(1_000_000 + 19_999);
      await controller.listDailyMarketCapSum('2026-01-01', '2026-01-03');
      expect(transactionsRepository.query).toHaveBeenCalledTimes(3);

      now.mockReturnValue(1_000_000 + 20_000);
      await controller.listDailyMarketCapSum('2026-01-01', '2026-01-03');
      expect(transactionsRepository.query).toHaveBeenCalledTimes(6);
    });

    it('starts no more days after a failure and does not keep the failure', async () => {
      holdQueries();
      transactionsRepository.query.mockImplementationOnce(() =>
        Promise.reject(new Error('db down')),
      );

      const failed = expect(
        controller.listDailyMarketCapSum('2025-01-01', '2025-01-30'),
      ).rejects.toThrow('db down');
      await drain();
      await failed;
      // Only the first 20 started; the other 10 days never ran.
      expect(transactionsRepository.query).toHaveBeenCalledTimes(20);

      const retried = controller.listDailyMarketCapSum(
        '2025-01-01',
        '2025-01-30',
      );
      await drain();
      await expect(retried).resolves.toHaveLength(30);
      expect(transactionsRepository.query).toHaveBeenCalledTimes(50);
    });

    it('starts a new load once a stuck one is past its deadline', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      holdQueries();

      const stuck = controller.listDailyMarketCapSum(
        '2026-01-01',
        '2026-01-01',
      );
      await flush();
      now.mockReturnValue(1_000_000 + 5 * 60_000 - 1);
      const shared = controller.listDailyMarketCapSum(
        '2026-01-01',
        '2026-01-01',
      );
      await flush();
      expect(transactionsRepository.query).toHaveBeenCalledTimes(1);

      now.mockReturnValue(1_000_000 + 5 * 60_000);
      const fresh = controller.listDailyMarketCapSum(
        '2026-01-01',
        '2026-01-01',
      );
      await flush();
      expect(transactionsRepository.query).toHaveBeenCalledTimes(2);

      await drain();
      await Promise.all([stuck, shared, fresh]);
    });

    it('keeps the fresh load when the stuck one it replaced fails', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      holdQueries();
      let failStuck!: (error: Error) => void;
      transactionsRepository.query.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            failStuck = reject;
          }),
      );

      const stuck = controller.listDailyMarketCapSum(
        '2026-01-01',
        '2026-01-01',
      );
      const stuckFailed = expect(stuck).rejects.toThrow('connection lost');
      await flush();
      now.mockReturnValue(1_000_000 + 5 * 60_000);
      const fresh = controller.listDailyMarketCapSum(
        '2026-01-01',
        '2026-01-01',
      );
      await flush();

      failStuck(new Error('connection lost'));
      await stuckFailed;
      const later = controller.listDailyMarketCapSum(
        '2026-01-01',
        '2026-01-01',
      );
      await flush();
      expect(transactionsRepository.query).toHaveBeenCalledTimes(2);

      await drain();
      await expect(later).resolves.toEqual(await fresh);
    });
  });
});

import { Token } from '@/tokens/entities/token.entity';
import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import moment from 'moment';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Transaction } from '../entities/transaction.entity';

import { TokensService } from '@/tokens/tokens.service';
import { TransactionHistoryService } from './transaction-history.service';
import { TransactionService } from './transaction.service';

describe('TransactionHistoryService', () => {
  let service: TransactionHistoryService;
  let transactionsRepository: jest.Mocked<Repository<Transaction>>;
  let tokenRepository: jest.Mocked<Repository<Token>>;
  let dataSource: jest.Mocked<DataSource>;
  let transactionService: jest.Mocked<TransactionService>;
  let tokenService: jest.Mocked<TokensService>;

  beforeEach(async () => {
    transactionsRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
        getOne: jest.fn().mockResolvedValue(null),
        getRawOne: jest.fn().mockResolvedValue(null),
        getRawMany: jest.fn().mockResolvedValue([]),
        limit: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
      }),
    } as any;

    tokenRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
        getOne: jest.fn().mockResolvedValue(null),
        getRawOne: jest.fn().mockResolvedValue(null),
        getRawMany: jest.fn().mockResolvedValue([]),
        limit: jest.fn().mockReturnThis(),
      }),
    } as any;

    dataSource = {
      createQueryRunner: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    } as any;

    transactionService = {
      saveTransaction: jest.fn().mockResolvedValue({}),
    } as any;

    tokenService = {
      getToken: jest.fn().mockResolvedValue(new Token()),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionHistoryService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        { provide: getRepositoryToken(Token), useValue: tokenRepository },
        { provide: DataSource, useValue: dataSource },
        { provide: TransactionService, useValue: transactionService },
        { provide: TokensService, useValue: tokenService },
      ],
    }).compile();

    service = module.get<TransactionHistoryService>(TransactionHistoryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  const makeToken = () =>
    Object.assign(new Token(), { sale_address: 'ct_sale', symbol: 'TKN' });

  describe('getPaginatedHistoricalData', () => {
    const fetchHistory = (overrides: Record<string, unknown> = {}) =>
      service.getPaginatedHistoricalData({
        token: makeToken(),
        interval: 3600,
        page: 1,
        limit: 100,
        convertTo: 'ae',
        ...overrides,
      } as any);

    it('passes convertTo, offset and limit as bound parameters', async () => {
      await fetchHistory({ convertTo: 'usd', page: 3, limit: 25 });

      expect(dataSource.query).toHaveBeenCalledTimes(1);
      const [sql, params] = (dataSource.query as jest.Mock).mock.calls[0];
      expect(params).toEqual(['ct_sale', 3600, 'usd', 50, 25]);
      expect(sql).toContain('t.buy_price->>$3');
      expect(sql).toContain('t.market_cap->>$3');
      expect(sql).toContain('OFFSET $4');
      expect(sql).toContain('LIMIT $5');
      expect(sql).not.toContain("'usd'");
    });

    it('lowercases convertTo', async () => {
      (dataSource.query as jest.Mock).mockResolvedValueOnce([
        { timeOpen: new Date(0), close: '2' },
      ]);

      const [candle] = await fetchHistory({ convertTo: 'USD' });

      expect((dataSource.query as jest.Mock).mock.calls[0][1][2]).toBe('usd');
      expect(candle.quote.convertedTo).toBe('usd');
    });

    it.each(["ae' || (SELECT 1) || '", 'zzz', '__proto__', ['ae', 'usd']])(
      'rejects convertTo %p without querying',
      async (convertTo) => {
        await expect(fetchHistory({ convertTo })).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(dataSource.query).not.toHaveBeenCalled();
      },
    );

    it.each([0, -60, 1.5, Number.NaN])(
      'rejects interval %p without querying',
      async (interval) => {
        await expect(fetchHistory({ interval })).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(dataSource.query).not.toHaveBeenCalled();
      },
    );

    it('clamps page and limit', async () => {
      await fetchHistory({ page: 0, limit: 1_000_000 });

      const [, params] = (dataSource.query as jest.Mock).mock.calls[0];
      expect(params.slice(3)).toEqual([0, 100]);
    });
  });

  describe('getHistoricalData', () => {
    const fetchHistory = (overrides: Record<string, unknown> = {}) =>
      service.getHistoricalData({
        token: makeToken(),
        interval: 3600,
        startDate: moment.utc('2026-01-01T00:00:00Z'),
        endDate: moment.utc('2026-01-01T01:00:00Z'),
        convertTo: 'ae',
        mode: 'normal',
        ...overrides,
      } as any);

    it('reads prices in the lowercased convertTo currency', async () => {
      const transaction = Object.assign(new Transaction(), {
        created_at: new Date('2026-01-01T00:30:00Z'),
        buy_price: { ae: '1', usd: '2' },
        market_cap: { ae: '10', usd: '20' },
      });
      (
        transactionsRepository.createQueryBuilder().getMany as jest.Mock
      ).mockResolvedValueOnce([transaction]);

      const [candle] = await fetchHistory({ convertTo: 'USD' });

      expect(candle.quote).toMatchObject({
        convertedTo: 'usd',
        close: '2',
        market_cap: '20',
      });
    });

    it.each([
      { convertTo: 'constructor' },
      { convertTo: "ae' --" },
      { interval: 0 },
      { interval: -3600 },
    ])('rejects %p without querying', async (overrides) => {
      (transactionsRepository.createQueryBuilder as jest.Mock).mockClear();

      await expect(fetchHistory(overrides)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(transactionsRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  // it('should fetch and save transactions successfully', async () => {
  //   const mockToken = new Token();
  //   mockToken.sale_address = 'ct_123';

  //   jest.spyOn(global, 'fetchJson').mockResolvedValue({ data: [], next: null });
  //   await syncTransactionsQueue.fetchAndSaveTransactions(
  //     mockToken,
  //     'http://example.com',
  //   );
  //   expect(fetchJson).toHaveBeenCalledWith('http://example.com');
  // });
});

import { PairHistoryService } from './pair-history.service';
import { Pair } from '../entities/pair.entity';

describe('PairHistoryService', () => {
  let service: PairHistoryService;
  let queryRunnerMock: { query: jest.Mock; release: jest.Mock };
  let dataSourceMock: { createQueryRunner: jest.Mock };

  beforeEach(() => {
    queryRunnerMock = {
      query: jest.fn().mockResolvedValue([]),
      release: jest.fn().mockResolvedValue(undefined),
    };
    dataSourceMock = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunnerMock),
    };

    service = new PairHistoryService(
      {} as any,
      dataSourceMock as any,
      {} as any,
    );
  });

  const makePair = (address = 'ct_testPairAddress'): Pair =>
    ({
      address,
      token0: { symbol: 'TOK0' },
      token1: { symbol: 'TOK1' },
    }) as any;

  describe('getPaginatedHistoricalData - SQL parameterization', () => {
    it('passes offset and limit as positional parameters $3 and $4', async () => {
      await service.getPaginatedHistoricalData({
        pair: makePair(),
        interval: 3600,
        page: 3,
        limit: 25,
        fromToken: 'token0',
      });

      expect(queryRunnerMock.query).toHaveBeenCalledTimes(1);
      const [sql, params] = queryRunnerMock.query.mock.calls[0];

      expect(params).toEqual(['ct_testPairAddress', 3600, 50, 25]);
      expect(sql).toContain('OFFSET $3');
      expect(sql).toContain('LIMIT $4');
      expect(sql).not.toMatch(/OFFSET \$\{/);
      expect(sql).not.toMatch(/LIMIT \$\{/);
    });

    it('uses make_interval for timeClose instead of string-interpolated interval', async () => {
      await service.getPaginatedHistoricalData({
        pair: makePair(),
        interval: 7200,
        page: 1,
        limit: 10,
        fromToken: 'token1',
      });

      const [sql] = queryRunnerMock.query.mock.calls[0];
      expect(sql).toContain('make_interval(secs => $2)');
      expect(sql).not.toContain("interval '$2 seconds'");
    });

    it('selects ratio0 columns when fromToken is token0', async () => {
      await service.getPaginatedHistoricalData({
        pair: makePair(),
        interval: 3600,
        page: 1,
        limit: 10,
        fromToken: 'token0',
      });

      const [sql] = queryRunnerMock.query.mock.calls[0];
      expect(sql).toContain('ratio0');
      expect(sql).toContain('volume0');
    });

    it('selects ratio1 columns when fromToken is token1', async () => {
      await service.getPaginatedHistoricalData({
        pair: makePair(),
        interval: 3600,
        page: 1,
        limit: 10,
        fromToken: 'token1',
      });

      const [sql] = queryRunnerMock.query.mock.calls[0];
      expect(sql).toContain('ratio1');
      expect(sql).toContain('volume1');
    });

    it('releases the queryRunner even when the query throws', async () => {
      queryRunnerMock.query.mockRejectedValue(new Error('db down'));

      await expect(
        service.getPaginatedHistoricalData({
          pair: makePair(),
          interval: 3600,
          page: 1,
          limit: 10,
        }),
      ).rejects.toThrow('db down');

      expect(queryRunnerMock.release).toHaveBeenCalledTimes(1);
    });

    it('maps raw results to HistoricalDataDto with previous close chaining', async () => {
      queryRunnerMock.query.mockResolvedValue([
        {
          timeOpen: new Date('2025-01-01T00:00:00Z'),
          timeClose: new Date('2025-01-01T01:00:00Z'),
          low: '1.0',
          high: '2.0',
          open: '1.5',
          close: '1.8',
          volume: '100',
          market_cap: '5000',
          total_supply: '10000',
          timeMin: new Date('2025-01-01T00:05:00Z'),
          timeMax: new Date('2025-01-01T00:55:00Z'),
        },
        {
          timeOpen: new Date('2025-01-01T01:00:00Z'),
          timeClose: new Date('2025-01-01T02:00:00Z'),
          low: '1.7',
          high: '2.5',
          open: '1.9',
          close: '2.2',
          volume: '200',
          market_cap: '6000',
          total_supply: '10000',
          timeMin: new Date('2025-01-01T01:10:00Z'),
          timeMax: new Date('2025-01-01T01:50:00Z'),
        },
      ]);

      const result = await service.getPaginatedHistoricalData({
        pair: makePair(),
        interval: 3600,
        page: 1,
        limit: 10,
        fromToken: 'token0',
      });

      expect(result).toHaveLength(2);
      expect(result[0].quote.open).toBe('1.5');
      expect(result[0].quote.close).toBe('1.8');
      // second interval's open should be the previous close
      expect(result[1].quote.open).toBe('1.8');
    });
  });
});

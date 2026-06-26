import { BadRequestException } from '@nestjs/common';
import { PairHistoryService } from './pair-history.service';
import { Pair } from '../entities/pair.entity';
import { DEX_CONTRACTS } from '../config/dex-contracts.config';

describe('PairHistoryService', () => {
  let service: PairHistoryService;
  let queryRunnerMock: { query: jest.Mock; release: jest.Mock };
  let dataSourceMock: { createQueryRunner: jest.Mock };
  let aePricingMock: { getCurrencyRates: jest.Mock };

  beforeEach(() => {
    queryRunnerMock = {
      query: jest.fn().mockResolvedValue([]),
      release: jest.fn().mockResolvedValue(undefined),
    };
    dataSourceMock = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunnerMock),
    };
    aePricingMock = {
      getCurrencyRates: jest.fn(),
    };

    service = new PairHistoryService(
      {} as any,
      dataSourceMock as any,
      aePricingMock as any,
    );
  });

  const makePair = (address = 'ct_testPairAddress'): Pair =>
    ({
      address,
      token0: { symbol: 'TOK0' },
      token1: { symbol: 'TOK1' },
    }) as any;

  // A pair quoted against WAE: token1 is WAE, so with fromToken='token1' the
  // base (quote) token is WAE and prices are AE-denominated → convertible.
  const makeWaePair = (address = 'ct_waePair'): Pair =>
    ({
      address,
      token0: { symbol: 'TOK', address: 'ct_token' },
      token1: { symbol: 'WAE', address: DEX_CONTRACTS.wae },
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

  describe('getPaginatedHistoricalData - decimal normalization', () => {
    // Token (token0, 6 decimals) priced against WAE (token1, 18 decimals).
    // fromToken='token1' means WAE is the base, so the series is the token's
    // price in AE. Stored ratios use RAW reserves, so the price must be scaled
    // by 10^(quoteDecimals - baseDecimals) = 10^(6 - 18) = 10^-12.
    const make6DecVsWaePair = (): Pair =>
      ({
        address: 'ct_token6dec_wae',
        token0: { symbol: 'TOK', address: 'ct_token', decimals: 6 },
        token1: { symbol: 'WAE', address: DEX_CONTRACTS.wae, decimals: 18 },
      }) as any;

    it('scales raw ratios to human price using the token decimals', async () => {
      // Raw ratio1 = reserveWAE_raw / reserveTOK_raw. For 1000 WAE (1000e18)
      // and 2000 TOK (2000e6): 1000e18 / 2000e6 = 5e11. Human price = 0.5 AE.
      queryRunnerMock.query.mockResolvedValue([
        {
          timeOpen: new Date('2025-01-01T00:00:00Z'),
          timeClose: new Date('2025-01-01T01:00:00Z'),
          low: '500000000000',
          high: '500000000000',
          open: '500000000000',
          close: '500000000000',
          volume: '0',
          timeMin: new Date('2025-01-01T00:05:00Z'),
          timeMax: new Date('2025-01-01T00:55:00Z'),
        },
      ]);

      const [result] = await service.getPaginatedHistoricalData({
        pair: make6DecVsWaePair(),
        interval: 3600,
        page: 1,
        limit: 10,
        fromToken: 'token1',
      });

      expect(result.quote.close).toBe('0.5');
      expect(result.quote.open).toBe('0.5');
      // The charted token's symbol is the non-base token (TOK), not token0 blindly.
      expect(result.quote.symbol).toBe('TOK');
    });

    it('leaves prices unscaled when both tokens share 18 decimals', async () => {
      queryRunnerMock.query.mockResolvedValue([
        {
          timeOpen: new Date('2025-01-01T00:00:00Z'),
          timeClose: new Date('2025-01-01T01:00:00Z'),
          low: '1.0',
          high: '2.0',
          open: '1.5',
          close: '1.8',
          volume: '0',
          timeMin: new Date('2025-01-01T00:05:00Z'),
          timeMax: new Date('2025-01-01T00:55:00Z'),
        },
      ]);

      const [result] = await service.getPaginatedHistoricalData({
        pair: {
          address: 'ct_equal',
          token0: { symbol: 'A', address: 'ct_a', decimals: 18 },
          token1: { symbol: 'B', address: 'ct_b', decimals: 18 },
        } as any,
        interval: 3600,
        page: 1,
        limit: 10,
        fromToken: 'token0',
      });

      expect(result.quote.close).toBe('1.8');
    });
  });

  describe('getPaginatedHistoricalData - denomination & volume', () => {
    const baseRow = (overrides: Record<string, unknown> = {}) => ({
      timeOpen: new Date('2025-01-01T00:00:00Z'),
      timeClose: new Date('2025-01-01T01:00:00Z'),
      low: '1',
      high: '1',
      open: '1',
      close: '1',
      volume: '0',
      timeMin: new Date('2025-01-01T00:05:00Z'),
      timeMax: new Date('2025-01-01T00:55:00Z'),
      ...overrides,
    });

    it('labels the series with the base token symbol for a non-WAE pool', async () => {
      // makePair has no WAE token; with fromToken='token0' the base (quote)
      // token is token0 (TOK0), so the series is priced in TOK0, NOT AE.
      queryRunnerMock.query.mockResolvedValue([baseRow()]);

      const [result] = await service.getPaginatedHistoricalData({
        pair: makePair(),
        interval: 3600,
        page: 1,
        limit: 10,
        fromToken: 'token0',
      });

      expect(result.quote.convertedTo).toBe('TOK0');
    });

    it('normalizes volume to human base-token units (ae)', async () => {
      // 5 WAE in aettos → human volume 5.
      queryRunnerMock.query.mockResolvedValue([
        baseRow({ volume: '5000000000000000000' }),
      ]);

      const [result] = await service.getPaginatedHistoricalData({
        pair: makeWaePair(),
        interval: 3600,
        page: 1,
        limit: 10,
        fromToken: 'token1',
      });

      expect(result.quote.volume).toBe(5);
    });

    it('applies decimal normalization before the fiat rate for volume', async () => {
      queryRunnerMock.query.mockResolvedValue([
        baseRow({ volume: '5000000000000000000', conversion_rate: '2' }),
      ]);

      const [result] = await service.getPaginatedHistoricalData({
        pair: makeWaePair(),
        interval: 3600,
        page: 1,
        limit: 10,
        fromToken: 'token1',
        convertTo: 'usd',
      });

      // human 5 AE * rate 2 = 10 USD — NOT 5e18 * 2.
      expect(result.quote.volume).toBe(10);
    });
  });

  describe('getPaginatedHistoricalData - currency conversion', () => {
    const makeRow = (overrides: Record<string, unknown> = {}) => ({
      timeOpen: new Date('2025-01-01T00:00:00Z'),
      timeClose: new Date('2025-01-01T01:00:00Z'),
      low: '1.0',
      high: '2.0',
      open: '1.5',
      close: '1.8',
      // Raw base-token (WAE, 18 dp) volume of 100 → human volume 100.
      volume: '100000000000000000000',
      market_cap: '5000',
      total_supply: '10000',
      timeMin: new Date('2025-01-01T00:05:00Z'),
      timeMax: new Date('2025-01-01T00:55:00Z'),
      ...overrides,
    });

    it('leaves values untouched and labels them "ae" by default (no fiat conversion)', async () => {
      queryRunnerMock.query.mockResolvedValue([makeRow()]);

      const [result] = await service.getPaginatedHistoricalData({
        pair: makeWaePair(),
        interval: 3600,
        page: 1,
        limit: 10,
        fromToken: 'token1',
      });

      expect(result.quote.convertedTo).toBe('ae');
      expect(result.quote.close).toBe('1.8');
      // volume is normalized from raw base-token units (100e18) to human (100).
      expect(result.quote.volume).toBe(100);
      // market_cap is not tracked for DEX pairs → null, not a fabricated value.
      expect(result.quote.market_cap).toBeNull();
      expect(result.quote.total_supply).toBeNull();
      // No $5 currency parameter and no coin_prices join when not converting.
      const [sql, params] = queryRunnerMock.query.mock.calls[0];
      expect(params).toHaveLength(4);
      expect(sql).not.toContain('coin_prices');
      expect(aePricingMock.getCurrencyRates).not.toHaveBeenCalled();
    });

    it('joins coin_prices and passes the currency as $5 when converting', async () => {
      queryRunnerMock.query.mockResolvedValue([
        makeRow({ conversion_rate: '0.5' }),
      ]);

      await service.getPaginatedHistoricalData({
        pair: makeWaePair(),
        interval: 3600,
        page: 2,
        limit: 25,
        fromToken: 'token1',
        convertTo: 'usd',
      });

      const [sql, params] = queryRunnerMock.query.mock.calls[0];
      expect(sql).toContain('coin_prices');
      expect(sql).toContain('cp.rates->>$5');
      expect(sql).toContain('as conversion_rate');
      expect(params).toEqual(['ct_waePair', 3600, 25, 25, 'usd']);
    });

    it('converts each candle by its own historical rate from coin_prices', async () => {
      // Two candles with different historical AE→USD rates.
      queryRunnerMock.query.mockResolvedValue([
        makeRow({ conversion_rate: '0.5' }),
        makeRow({ open: '1.9', close: '2.2', conversion_rate: '2' }),
      ]);

      const result = await service.getPaginatedHistoricalData({
        pair: makeWaePair(),
        interval: 3600,
        page: 1,
        limit: 10,
        fromToken: 'token1',
        convertTo: 'usd',
      });

      expect(result[0].quote.convertedTo).toBe('usd');
      expect(result[0].quote.high).toBe('1'); // 2.0 * 0.5
      expect(result[0].quote.close).toBe('0.9'); // 1.8 * 0.5
      // volume: 100e18 raw → human 100 → fiat 100 * 0.5 = 50
      expect(result[0].quote.volume).toBe(50);
      // market_cap / total_supply are not tracked for DEX pairs → null.
      expect(result[0].quote.market_cap).toBeNull();
      expect(result[0].quote.total_supply).toBeNull();
      // Second candle uses its OWN rate (2), not the first candle's.
      expect(result[1].quote.close).toBe('4.4'); // 2.2 * 2
      // previous-close carry-over keeps the already-converted close
      expect(result[1].quote.open).toBe('0.9');
      expect(aePricingMock.getCurrencyRates).not.toHaveBeenCalled();
    });

    it('falls back to the latest rate when a candle predates any coin_prices snapshot', async () => {
      aePricingMock.getCurrencyRates.mockResolvedValue({ usd: 3 } as any);
      queryRunnerMock.query.mockResolvedValue([
        makeRow({ conversion_rate: null }),
      ]);

      const [result] = await service.getPaginatedHistoricalData({
        pair: makeWaePair(),
        interval: 3600,
        page: 1,
        limit: 10,
        fromToken: 'token1',
        convertTo: 'usd',
      });

      expect(aePricingMock.getCurrencyRates).toHaveBeenCalledTimes(1);
      expect(result.quote.close).toBe('5.4'); // 1.8 * 3 (fallback)
    });

    it('omits candles with no rate and no usable fallback instead of using rate 1', async () => {
      // getCurrencyRates returns nothing usable for usd → no fallback rate.
      aePricingMock.getCurrencyRates.mockResolvedValue({} as any);
      queryRunnerMock.query.mockResolvedValue([
        makeRow({ conversion_rate: '2' }), // convertible
        makeRow({ conversion_rate: null }), // no rate + no fallback → omitted
      ]);

      const result = await service.getPaginatedHistoricalData({
        pair: makeWaePair(),
        interval: 3600,
        page: 1,
        limit: 10,
        fromToken: 'token1',
        convertTo: 'usd',
      });

      // The un-convertible candle is dropped, NOT emitted at rate 1.
      expect(result).toHaveLength(1);
      expect(result[0].quote.convertedTo).toBe('usd');
      expect(result[0].quote.close).toBe('3.6'); // 1.8 * 2
    });

    it('rejects fiat conversion for a pool not quoted against WAE before querying', async () => {
      await expect(
        service.getPaginatedHistoricalData({
          pair: makePair(), // tokens have no WAE address
          interval: 3600,
          page: 1,
          limit: 10,
          fromToken: 'token1',
          convertTo: 'usd',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(queryRunnerMock.query).not.toHaveBeenCalled();
      expect(aePricingMock.getCurrencyRates).not.toHaveBeenCalled();
    });

    it('rejects an unsupported convertTo currency before querying', async () => {
      await expect(
        service.getPaginatedHistoricalData({
          pair: makeWaePair(),
          interval: 3600,
          page: 1,
          limit: 10,
          fromToken: 'token1',
          convertTo: 'jpy',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(queryRunnerMock.query).not.toHaveBeenCalled();
      expect(aePricingMock.getCurrencyRates).not.toHaveBeenCalled();
    });
  });
});

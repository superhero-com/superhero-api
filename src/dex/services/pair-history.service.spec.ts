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

    it('drops a dust-state candle whose price is beyond the chartable range', async () => {
      // 18/18 pair (priceScale = 1). The first candle is a normal price; the
      // second is a 5e17 dust artifact that must be omitted, not emitted as an
      // unplottable spike.
      queryRunnerMock.query.mockResolvedValue([
        {
          timeOpen: new Date('2025-01-01T00:00:00Z'),
          timeClose: new Date('2025-01-01T01:00:00Z'),
          low: '1',
          high: '1',
          open: '1',
          close: '1',
          volume: '0',
          timeMin: new Date('2025-01-01T00:05:00Z'),
          timeMax: new Date('2025-01-01T00:55:00Z'),
        },
        {
          timeOpen: new Date('2025-01-02T00:00:00Z'),
          timeClose: new Date('2025-01-02T01:00:00Z'),
          low: '500000000000000000',
          high: '500000000000000000',
          open: '500000000000000000',
          close: '500000000000000000',
          volume: '0',
          timeMin: new Date('2025-01-02T00:05:00Z'),
          timeMax: new Date('2025-01-02T00:55:00Z'),
        },
      ]);

      const result = await service.getPaginatedHistoricalData({
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

      expect(result).toHaveLength(1);
      expect(result[0].quote.close).toBe('1');
    });

    it('allows fiat conversion when the charted token itself is WAE (AE/currency rate)', async () => {
      // WAE (token0) / IMAE (token1), fromToken='token1' → base is IMAE,
      // quote (charted) token is WAE. baseIsWae is false, but quoteIsWae is
      // true, so fiat must be allowed: price = 1 AE × rate = the AE/USD rate.
      queryRunnerMock.query.mockResolvedValue([
        {
          timeOpen: new Date('2025-01-01T00:00:00Z'),
          timeClose: new Date('2025-01-01T01:00:00Z'),
          low: '5',
          high: '5',
          open: '5',
          close: '5',
          volume: '0',
          timeMin: new Date('2025-01-01T00:05:00Z'),
          timeMax: new Date('2025-01-01T00:55:00Z'),
          conversion_rate: '0.005',
        },
      ]);

      const [result] = await service.getPaginatedHistoricalData({
        pair: {
          address: 'ct_wae_imae',
          token0: { symbol: 'WAE', address: DEX_CONTRACTS.wae, decimals: 18 },
          token1: { symbol: 'IMAE', address: 'ct_imae', decimals: 18 },
        } as any,
        interval: 3600,
        page: 1,
        limit: 10,
        fromToken: 'token1',
        convertTo: 'usd',
      });

      expect(result.quote.convertedTo).toBe('usd');
      expect(result.quote.close).toBe('0.005');
    });

    it('charts WAE itself as a flat 1 AE, not the pool ratio against the base', async () => {
      // WAE (token0) / IMAE (token1). Charting WAE means the base side is IMAE,
      // so the SQL price is the WAE/IMAE ratio (~0.003). But WAE is wrapped AE,
      // so its AE price must be a flat 1 — never that unrelated ratio.
      queryRunnerMock.query.mockResolvedValue([
        {
          timeOpen: new Date('2025-01-01T00:00:00Z'),
          timeClose: new Date('2025-01-01T01:00:00Z'),
          low: '0.003',
          high: '0.003',
          open: '0.003',
          close: '0.003',
          volume: '0',
          timeMin: new Date('2025-01-01T00:05:00Z'),
          timeMax: new Date('2025-01-01T00:55:00Z'),
        },
      ]);

      const [result] = await service.getPaginatedHistoricalData({
        pair: {
          address: 'ct_wae_imae',
          token0: { symbol: 'WAE', address: DEX_CONTRACTS.wae, decimals: 18 },
          token1: { symbol: 'IMAE', address: 'ct_imae', decimals: 18 },
        } as any,
        interval: 3600,
        page: 1,
        limit: 10,
        fromToken: 'token1',
      });

      expect(result.quote.close).toBe('1');
      expect(result.quote.open).toBe('1');
      expect(result.quote.high).toBe('1');
      expect(result.quote.low).toBe('1');
      expect(result.quote.convertedTo).toBe('ae');
      expect(result.quote.symbol).toBe('WAE');
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

  describe('calculatePairSummary', () => {
    // Route each mocked query to a sensible response by inspecting its SQL so
    // the JS-side arithmetic (price-change) actually runs against real numbers.
    const wireQueries = (opts: {
      totalVolume?: string;
      periodVolume?: string;
      startPrice?: string | null;
      currentPrice?: string | null;
    }) => {
      queryRunnerMock.query.mockImplementation((sql: string) => {
        if (sql.includes('start_price')) {
          return Promise.resolve([
            {
              start_price: opts.startPrice ?? null,
              current_price: opts.currentPrice ?? null,
            },
          ]);
        }
        // volume queries (total + per-period)
        return Promise.resolve([
          { total_volume: opts.periodVolume ?? opts.totalVolume ?? '0' },
        ]);
      });
    };

    // Every supplied parameter MUST be referenced in the SQL. Postgres infers a
    // parameter's type from its usage, so an unreferenced $N aborts the whole
    // query with "could not determine data type of parameter $N" at runtime —
    // which mocked-query tests don't otherwise catch.
    const assertNoDanglingParams = (sql: unknown, params: unknown[]) => {
      const referenced = new Set(
        [...String(sql).matchAll(/\$(\d+)/g)].map((m) => Number(m[1])),
      );
      for (let i = 1; i <= params.length; i++) {
        expect(referenced.has(i)).toBe(true);
      }
    };

    it('issues no query with a dangling/unreferenced parameter (Postgres type-inference)', async () => {
      (aePricingMock as any).getPriceData = jest
        .fn()
        .mockResolvedValue({ ae: 0 });
      wireQueries({ totalVolume: '0', startPrice: null, currentPrice: null });

      const pair = {
        address: 'ct_p',
        token0: { address: 'ct_t', decimals: 6 },
        token1: { address: DEX_CONTRACTS.wae, decimals: 18 },
      } as any;

      await service.calculatePairSummary(pair);

      const calls = queryRunnerMock.query.mock.calls.filter((c) =>
        Array.isArray(c[1]),
      );
      expect(calls.length).toBeGreaterThan(0);
      for (const [sql, params] of calls) {
        assertNoDanglingParams(sql, params as unknown[]);
      }
    });

    it('takes the WAE leg directly and never reconstructs via the reserve ratio (dust-safe)', async () => {
      (aePricingMock as any).getPriceData = jest
        .fn()
        .mockResolvedValue({ ae: 0 });
      wireQueries({ totalVolume: '0' });

      const pair = {
        address: 'ct_p',
        token0: { address: 'ct_t', decimals: 6 },
        token1: { address: DEX_CONTRACTS.wae, decimals: 18 },
      } as any;

      await service.calculatePairSummary(pair);

      const volCall = queryRunnerMock.query.mock.calls.find(
        (c) =>
          String(c[0]).includes('total_volume') &&
          String(c[0]).includes('POW(10'),
      );
      expect(volCall).toBeDefined();
      const volSql = String(volCall[0]);
      // The WAE side is taken directly (param $2 — no dangling $2 placeholder)...
      expect(volSql).toContain('token1.address = $2 THEN pt.volume1');
      expect(volCall[1]).toContain(DEX_CONTRACTS.wae);
      const allSql = queryRunnerMock.query.mock.calls
        .map((c) => String(c[0]))
        .join('\n');
      // ...and the dust-exploding reconstruction is gone for good.
      expect(allSql).not.toContain('volume0 * ratio1');
      expect(allSql).not.toMatch(
        /reserve1 \/ POW\(10, token1\.decimals\)\)\) \//,
      );
      expect(allSql).not.toContain('NULLIF(pt.reserve0');
    });

    it('computes price-change percentage from decimal-normalized ratios', async () => {
      (aePricingMock as any).getPriceData = jest
        .fn()
        .mockResolvedValue({ ae: 0 });
      // token0 has 6 decimals, WAE (token1) 18. No token param → selected token
      // is the WAE side (volumeToken='1'), so otherToken='0' and priceScale is
      // 10^(dec1-dec0) = 10^12. Raw ratios 1e-12 and 1.1e-12 → human 1 and 1.1.
      wireQueries({
        totalVolume: '0',
        periodVolume: '0',
        startPrice: '0.000000000001',
        currentPrice: '0.0000000000011',
      });

      const pair = {
        address: 'ct_p',
        token0: { address: 'ct_t', decimals: 6 },
        token1: { address: DEX_CONTRACTS.wae, decimals: 18 },
      } as any;

      const result: any = await service.calculatePairSummary(pair);

      // (1.1 - 1) / 1 * 100 = 10%, value = 0.1 — exact in BigNumber.
      expect(result.change['24h'].price_change.percentage).toBe('10');
      expect(result.change['24h'].price_change.value).toBe('0.1');
    });

    it('reports no change (0.00) when the start price is a drained/dust artifact', async () => {
      (aePricingMock as any).getPriceData = jest
        .fn()
        .mockResolvedValue({ ae: 0 });
      // start_price = 0 → division guard must keep percentage at the default.
      wireQueries({
        totalVolume: '0',
        periodVolume: '0',
        startPrice: '0',
        currentPrice: '0.0000000000011',
      });

      const pair = {
        address: 'ct_p',
        token0: { address: 'ct_t', decimals: 6 },
        token1: { address: DEX_CONTRACTS.wae, decimals: 18 },
      } as any;

      const result: any = await service.calculatePairSummary(pair);

      expect(result.change['24h'].price_change.percentage).toBe('0.00');
      expect(result.change['24h'].price_change.value).toBe('0');
    });
  });

  describe('getForPreview', () => {
    it('normalizes ratio1 by decimals and uses a single price direction', async () => {
      // token0 = 6 dp, token1 = 18 dp → ratio1 raw scaled by 10^(6-18) = 1e-12.
      const pair = {
        address: 'ct_p',
        token0: { decimals: 6 },
        token1: { decimals: 18 },
      } as any;
      queryRunnerMock.query.mockResolvedValue([
        {
          truncated_time: new Date('2025-01-02T00:00:00Z'),
          last_ratio1: '500000000000',
        },
        {
          truncated_time: new Date('2025-01-01T00:00:00Z'),
          last_ratio1: '400000000000',
        },
      ]);

      const res: any = await service.getForPreview(pair, '7d');

      // 5e11 * 1e-12 = 0.5 ; 4e11 * 1e-12 = 0.4
      expect(res.result[0].last_price).toBe('0.5');
      expect(res.result[1].last_price).toBe('0.4');
      // No reciprocal-direction mixing: ratio0 is no longer referenced.
      expect(String(queryRunnerMock.query.mock.calls[0][0])).not.toContain(
        'ratio0',
      );
    });

    it('falls back to the 7d window for an unrecognised interval instead of crashing', async () => {
      // The HTTP layer can pass a value outside the '1d'|'7d'|'30d' union; the
      // service must not destructure `undefined` and 500.
      const pair = {
        address: 'ct_p',
        token0: { decimals: 18 },
        token1: { decimals: 18 },
      } as any;
      queryRunnerMock.query.mockResolvedValue([]);

      const res: any = await service.getForPreview(pair, 'BOGUS' as any);

      expect(res.timeframe).toBe('7 days');
    });

    it('drops a dust-state bucket whose price is beyond the chartable range', async () => {
      const pair = {
        address: 'ct_p',
        token0: { decimals: 18 },
        token1: { decimals: 18 },
      } as any;
      queryRunnerMock.query.mockResolvedValue([
        { truncated_time: new Date('2025-01-02T00:00:00Z'), last_ratio1: '1' },
        {
          truncated_time: new Date('2025-01-01T00:00:00Z'),
          last_ratio1: '500000000000000000',
        },
      ]);

      const res: any = await service.getForPreview(pair, '7d');

      expect(res.result).toHaveLength(1);
      expect(res.result[0].last_price).toBe('1');
    });
  });
});

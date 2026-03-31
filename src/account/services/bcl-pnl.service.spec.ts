import { BclPnlService, DailyPnlWindow } from './bcl-pnl.service';

describe('BclPnlService', () => {
  const createService = () => {
    const transactionRepository = {
      query: jest.fn(),
    };

    const service = new BclPnlService(transactionRepository as any);

    return {
      service,
      transactionRepository,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses LATERAL + LIMIT 1 for price lookups instead of DISTINCT ON full scans', async () => {
    const { service, transactionRepository } = createService();
    transactionRepository.query.mockResolvedValue([]);

    await service.calculateTokenPnls('ak_test', 100, 50);

    expect(transactionRepository.query).toHaveBeenCalledTimes(1);
    const [sql, params] = transactionRepository.query.mock.calls[0];

    expect(sql).toContain('WITH aggregated_holdings AS');
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('LIMIT 1');
    expect(sql).toContain('ae_price ON true');
    expect(sql).toContain('usd_price ON true');
    expect(sql).not.toContain('DISTINCT ON (tx.sale_address)');
    expect(sql).not.toContain('INNER JOIN aggregated_holdings agg');
    expect(params).toEqual(['ak_test', 100, 50]);
  });

  it('preserves cumulative pnl result semantics', async () => {
    const { service, transactionRepository } = createService();
    transactionRepository.query.mockResolvedValue([
      {
        sale_address: 'ct_token_one',
        current_holdings: '4',
        total_volume_bought: '6',
        total_amount_spent_ae: '18',
        total_amount_spent_usd: '36',
        total_amount_received_ae: '4',
        total_amount_received_usd: '8',
        total_volume_sold: '2',
        current_unit_price_ae: '5',
        current_unit_price_usd: '10',
      },
      {
        sale_address: 'ct_token_two',
        current_holdings: '2',
        total_volume_bought: '4',
        total_amount_spent_ae: '12',
        total_amount_spent_usd: '24',
        total_amount_received_ae: '0',
        total_amount_received_usd: '0',
        total_volume_sold: '0',
        current_unit_price_ae: '8',
        current_unit_price_usd: '16',
      },
    ]);

    const result = await service.calculateTokenPnls('ak_test', 100);

    expect(transactionRepository.query).toHaveBeenCalledWith(
      expect.any(String),
      ['ak_test', 100],
    );

    // Token one: spent 18 AE total, received 4 AE from sells, current value = 4 * 5 = 20
    // gain = received + currentValue - spent = 4 + 20 - 18 = 6
    // invested = totalAmountSpent = 18
    expect(result.pnls.ct_token_one).toEqual({
      current_unit_price: { ae: 5, usd: 10 },
      percentage: (6 / 18) * 100,
      invested: { ae: 18, usd: 36 },
      current_value: { ae: 20, usd: 40 },
      gain: { ae: 6, usd: 12 },
    });

    // Token two: spent 12 AE, no sells, current value = 2 * 8 = 16
    // gain = 0 + 16 - 12 = 4
    expect(result.pnls.ct_token_two).toEqual({
      current_unit_price: { ae: 8, usd: 16 },
      percentage: (4 / 12) * 100,
      invested: { ae: 12, usd: 24 },
      current_value: { ae: 16, usd: 32 },
      gain: { ae: 4, usd: 8 },
    });
    expect(result.totalCostBasisAe).toBe(30);
    expect(result.totalCostBasisUsd).toBe(60);
    expect(result.totalCurrentValueAe).toBe(36);
    expect(result.totalCurrentValueUsd).toBe(72);
    expect(result.totalGainAe).toBe(10);
    expect(result.totalGainUsd).toBe(20);
  });

  it('calculateTokenPnlsBatch runs a single query for all heights and groups results', async () => {
    const { service, transactionRepository } = createService();

    // Two heights, one token each
    transactionRepository.query.mockResolvedValue([
      {
        snapshot_height: 200,
        sale_address: 'ct_alpha',
        current_holdings: '3',
        total_volume_bought: '3',
        total_amount_spent_ae: '9',
        total_amount_spent_usd: '18',
        total_amount_received_ae: '0',
        total_amount_received_usd: '0',
        total_volume_sold: '0',
        current_unit_price_ae: '4',
        current_unit_price_usd: '8',
      },
      {
        snapshot_height: 300,
        sale_address: 'ct_alpha',
        current_holdings: '5',
        total_volume_bought: '5',
        total_amount_spent_ae: '15',
        total_amount_spent_usd: '30',
        total_amount_received_ae: '0',
        total_amount_received_usd: '0',
        total_volume_sold: '0',
        current_unit_price_ae: '6',
        current_unit_price_usd: '12',
      },
    ]);

    const result = await service.calculateTokenPnlsBatch('ak_test', [200, 300]);

    // Single DB round-trip regardless of number of heights
    expect(transactionRepository.query).toHaveBeenCalledTimes(1);
    const [sql, params] = transactionRepository.query.mock.calls[0];

    // Batch query uses UNNEST, a MATERIALIZED CTE (single tx scan), and LATERAL price lookups
    expect(sql).toContain('unnest($2::int[])');
    expect(sql).toContain('snapshot_height');
    expect(sql).toContain('AS MATERIALIZED');
    expect(sql).toContain('address_txs');
    expect(sql).not.toContain('JOIN transactions tx'); // no repeated scan of transactions
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('LIMIT 1');
    expect(sql).not.toContain(
      'DISTINCT ON (agg.snapshot_height, agg.sale_address)',
    );
    expect(params).toEqual(['ak_test', [200, 300]]);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(2);

    const at200 = result.get(200)!;
    expect(at200.pnls.ct_alpha.current_value.ae).toBe(12); // 3 * 4
    expect(at200.totalCurrentValueAe).toBe(12);

    const at300 = result.get(300)!;
    expect(at300.pnls.ct_alpha.current_value.ae).toBe(30); // 5 * 6
    expect(at300.totalCurrentValueAe).toBe(30);
  });

  it('calculateTokenPnlsBatch returns empty map for empty heights array', async () => {
    const { service, transactionRepository } = createService();

    const result = await service.calculateTokenPnlsBatch('ak_test', []);

    expect(transactionRepository.query).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('calculateTokenPnlsBatch deduplicates heights before querying', async () => {
    const { service, transactionRepository } = createService();
    transactionRepository.query.mockResolvedValue([]);

    await service.calculateTokenPnlsBatch('ak_test', [100, 100, 200, 100]);

    expect(transactionRepository.query).toHaveBeenCalledTimes(1);
    const [, params] = transactionRepository.query.mock.calls[0];
    // Duplicates removed; order of unique values is preserved
    expect(params[1]).toEqual([100, 200]);
  });

  it('calculateTokenPnlsBatch passes fromBlockHeight as $3 when provided', async () => {
    const { service, transactionRepository } = createService();
    transactionRepository.query.mockResolvedValue([]);

    await service.calculateTokenPnlsBatch('ak_test', [500], 50);

    const [sql, params] = transactionRepository.query.mock.calls[0];
    expect(sql).toContain('block_height >= $3');
    expect(params).toEqual(['ak_test', [500], 50]);
  });

  it('preserves range-based pnl result semantics (realized gains only)', async () => {
    const { service, transactionRepository } = createService();

    // Scenario: token was bought historically (6 tokens for 24 AE total, avg 4 AE each).
    // In the range: 4 more were bought for 20 AE, and 1 was sold for 8 AE.
    // Cumulative: 6 tokens for 24 AE total gives avg cost = 4 AE/token.
    // Range gain (realized only) = proceeds - (avgCost * volumeSold) = 8 - (4 * 1) = 4 AE
    transactionRepository.query.mockResolvedValue([
      {
        sale_address: 'ct_range',
        current_holdings: '5',
        total_volume_bought: '4',
        total_amount_spent_ae: '20',
        total_amount_spent_usd: '40',
        total_amount_received_ae: '8',
        total_amount_received_usd: '16',
        total_volume_sold: '1',
        current_unit_price_ae: '7',
        current_unit_price_usd: '14',
        cumulative_volume_bought: '6',
        cumulative_amount_spent_ae: '24',
        cumulative_amount_spent_usd: '48',
      },
    ]);

    const result = await service.calculateTokenPnls('ak_test', 100, 50);

    // avgCostAe = 24/6 = 4; costBasisAe = 4 * 1 sold = 4
    // gainAe = 8 (proceeds) - 4 (cost) = 4
    // current_value always = currentHoldings * unitPrice = 5 * 7 = 35 (for portfolio chart)
    expect(result.pnls.ct_range).toEqual({
      current_unit_price: { ae: 7, usd: 14 },
      percentage: (4 / 4) * 100,
      invested: { ae: 4, usd: 8 },
      current_value: { ae: 35, usd: 70 },
      gain: { ae: 4, usd: 8 },
    });
    expect(result.totalCostBasisAe).toBe(4);
    expect(result.totalCostBasisUsd).toBe(8);
    expect(result.totalCurrentValueAe).toBe(35);
    expect(result.totalCurrentValueUsd).toBe(70);
    expect(result.totalGainAe).toBe(4);
    expect(result.totalGainUsd).toBe(8);
  });

  it('includes fully closed positions in cumulative pnl', async () => {
    const { service, transactionRepository } = createService();

    // Token was bought for 10 AE and fully sold for 15 AE — position closed.
    // current_holdings = 0, but realized gain should still be reported.
    transactionRepository.query.mockResolvedValue([
      {
        sale_address: 'ct_closed',
        current_holdings: '0',
        total_volume_bought: '100',
        total_amount_spent_ae: '10',
        total_amount_spent_usd: '20',
        total_amount_received_ae: '15',
        total_amount_received_usd: '30',
        total_volume_sold: '100',
        current_unit_price_ae: '0.15',
        current_unit_price_usd: '0.3',
      },
    ]);

    const result = await service.calculateTokenPnls('ak_test', 200);

    // costBasisAe = totalAmountSpentAe = 10
    // currentValueAe = 0 * 0.15 = 0 (position is closed)
    // gainAe = 15 (received) + 0 (current) - 10 (spent) = 5
    expect(result.pnls.ct_closed).toEqual({
      current_unit_price: { ae: 0.15, usd: 0.3 },
      percentage: (5 / 10) * 100,
      invested: { ae: 10, usd: 20 },
      current_value: { ae: 0, usd: 0 },
      gain: { ae: 5, usd: 10 },
    });
    expect(result.totalCostBasisAe).toBe(10);
    expect(result.totalGainAe).toBe(5);
    expect(result.totalCurrentValueAe).toBe(0);
  });

  it('includes token sold in range but bought before range with correct realized pnl', async () => {
    const { service, transactionRepository } = createService();

    // Token was bought entirely before the range (cumulative: 10 tokens for 50 AE = 5 AE avg).
    // In the range: 0 new buys, but 10 tokens sold for 80 AE.
    // Expected realized gain = 80 - (5 * 10) = 30 AE
    transactionRepository.query.mockResolvedValue([
      {
        sale_address: 'ct_pre_bought',
        current_holdings: '0',
        total_volume_bought: '0',   // no buys in range
        total_amount_spent_ae: '0', // no buys in range
        total_amount_spent_usd: '0',
        total_amount_received_ae: '80',
        total_amount_received_usd: '160',
        total_volume_sold: '10',
        current_unit_price_ae: '8',
        current_unit_price_usd: '16',
        cumulative_volume_bought: '10',
        cumulative_amount_spent_ae: '50',
        cumulative_amount_spent_usd: '100',
      },
    ]);

    const result = await service.calculateTokenPnls('ak_test', 300, 200);

    // avgCostAe = 50/10 = 5; costBasisAe = 5 * 10 = 50
    // gainAe = 80 (proceeds) - 50 (cost) = 30
    expect(result.pnls.ct_pre_bought).toEqual({
      current_unit_price: { ae: 8, usd: 16 },
      percentage: (30 / 50) * 100,
      invested: { ae: 50, usd: 100 },
      current_value: { ae: 0, usd: 0 },
      gain: { ae: 30, usd: 60 },
    });
    expect(result.totalCostBasisAe).toBe(50);
    expect(result.totalGainAe).toBe(30);
    expect(result.totalCurrentValueAe).toBe(0);
  });

  // ── calculateDailyPnlBatch ────────────────────────────────────────────────

  it('calculateDailyPnlBatch issues one query with two float8 arrays and returns map keyed by snapshotTs', async () => {
    const { service, transactionRepository } = createService();
    transactionRepository.query.mockResolvedValue([]);

    const DAY1 = Date.UTC(2026, 0, 1);
    const DAY2 = Date.UTC(2026, 0, 2);
    const windows: DailyPnlWindow[] = [
      { snapshotTs: DAY1, dayStartTs: DAY1 },
      { snapshotTs: DAY2, dayStartTs: DAY1 },
    ];

    const result = await service.calculateDailyPnlBatch('ak_test', windows);

    expect(transactionRepository.query).toHaveBeenCalledTimes(1);
    const [sql, params] = transactionRepository.query.mock.calls[0];

    expect(sql).toContain('to_timestamp(unnest($2::float8[]))');
    expect(sql).toContain('to_timestamp(unnest($3::float8[]))');
    expect(sql).toContain('AS snapshot_ts');
    expect(sql).toContain('AS day_start_ts');
    expect(sql).toContain('snapshot_ts_ms');
    expect(sql).toContain('AS MATERIALIZED');

    // $2 = snapshot epoch seconds, $3 = day-start epoch seconds
    expect(params[0]).toBe('ak_test');
    expect(params[1]).toEqual([DAY1 / 1000, DAY2 / 1000]);
    expect(params[2]).toEqual([DAY1 / 1000, DAY1 / 1000]);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(2);
    expect(result.get(DAY1)).toBeDefined();
    expect(result.get(DAY2)).toBeDefined();
  });

  it('calculateDailyPnlBatch returns empty map for empty windows array', async () => {
    const { service, transactionRepository } = createService();

    const result = await service.calculateDailyPnlBatch('ak_test', []);

    expect(transactionRepository.query).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('calculateDailyPnlBatch: sells before dayStartTs are excluded from daily gain', async () => {
    const { service, transactionRepository } = createService();

    const DAY2 = Date.UTC(2026, 0, 2);
    const DAY1 = Date.UTC(2026, 0, 1);

    // The DB returns a row for a token where sells in the window = 0
    // (sells from before dayStart were excluded by the SQL WHERE clause).
    // Simulate: 10 tokens bought all-time, 5 sold before this day window,
    // 0 sold within today's window.
    transactionRepository.query.mockResolvedValue([
      {
        snapshot_ts_ms: String(DAY2),
        sale_address: 'ct_no_daily_sell',
        current_holdings: '5',
        cumulative_volume_bought: '10',
        cumulative_amount_spent_ae: '50',
        cumulative_amount_spent_usd: '100',
        total_volume_sold: '0',
        total_amount_received_ae: '0',
        total_amount_received_usd: '0',
        current_unit_price_ae: '6',
        current_unit_price_usd: '12',
      },
    ]);

    const result = await service.calculateDailyPnlBatch('ak_test', [
      { snapshotTs: DAY2, dayStartTs: DAY1 },
    ]);

    const day2 = result.get(DAY2)!;
    // No sells today → gain = 0, costBasis = 0
    expect(day2.pnls['ct_no_daily_sell'].gain.ae).toBe(0);
    expect(day2.pnls['ct_no_daily_sell'].invested.ae).toBe(0);
    // But current_value is still reported for portfolio display
    expect(day2.pnls['ct_no_daily_sell'].current_value.ae).toBe(5 * 6);
  });

  it('calculateDailyPnlBatch: token sold in day window uses all-time avg cost for gain', async () => {
    const { service, transactionRepository } = createService();

    // 10 tokens bought all-time for 50 AE total (avg 5 AE/token).
    // Today: 2 tokens sold for 14 AE.
    // Expected gain = 14 - (5 * 2) = 4 AE.
    const DAY3 = Date.UTC(2026, 0, 3);
    const DAY2 = Date.UTC(2026, 0, 2);

    transactionRepository.query.mockResolvedValue([
      {
        snapshot_ts_ms: String(DAY3),
        sale_address: 'ct_daily_sell',
        current_holdings: '8',
        cumulative_volume_bought: '10',
        cumulative_amount_spent_ae: '50',
        cumulative_amount_spent_usd: '100',
        total_volume_sold: '2',
        total_amount_received_ae: '14',
        total_amount_received_usd: '28',
        current_unit_price_ae: '7',
        current_unit_price_usd: '14',
      },
    ]);

    const result = await service.calculateDailyPnlBatch('ak_test', [
      { snapshotTs: DAY3, dayStartTs: DAY2 },
    ]);

    const day3 = result.get(DAY3)!;
    // avgCost = 50/10 = 5; costBasis = 5 * 2 = 10; gain = 14 - 10 = 4
    expect(day3.pnls['ct_daily_sell']).toEqual({
      current_unit_price: { ae: 7, usd: 14 },
      percentage: (4 / 10) * 100,
      invested: { ae: 10, usd: 20 },
      current_value: { ae: 8 * 7, usd: 8 * 14 },
      gain: { ae: 4, usd: 8 },
    });
    expect(day3.totalGainAe).toBe(4);
    expect(day3.totalCostBasisAe).toBe(10);
  });

  // ── calculateTradingStats ─────────────────────────────────────────────────

  it('calculateTradingStats issues one query with address and two date params', async () => {
    const { service, transactionRepository } = createService();
    transactionRepository.query.mockResolvedValue([
      {
        top_win_ae: '0',
        top_win_usd: '0',
        winning_sells: '0',
        total_sells: '0',
        avg_hold_secs: '0',
        unrealized_ae: '0',
        unrealized_usd: '0',
      },
    ]);

    const start = new Date('2026-01-01T00:00:00.000Z');
    const end = new Date('2026-01-31T00:00:00.000Z');

    await service.calculateTradingStats('ak_test', start, end);

    expect(transactionRepository.query).toHaveBeenCalledTimes(1);
    const [sql, params] = transactionRepository.query.mock.calls[0];

    expect(sql).toContain('address_txs AS MATERIALIZED');
    expect(sql).toContain('token_agg');
    expect(sql).toContain('range_sells');
    expect(sql).toContain('unrealized');
    expect(sql).toContain('CROSS JOIN unrealized');
    // top_win must come from a single trade via top_trade CTE (not independent MAX)
    expect(sql).toContain('top_trade');
    expect(sql).toContain('ORDER BY gain_ae DESC');
    expect(sql).not.toContain('MAX(gain_ae)');
    expect(sql).not.toContain('MAX(gain_usd)');
    expect(params[0]).toBe('ak_test');
    expect(params[1]).toBe(start);
    expect(params[2]).toBe(end);
  });

  it('calculateTradingStats returns correct stats from mock row', async () => {
    const { service, transactionRepository } = createService();

    // Scenario:
    // - 3 sells in range: 2 winning (gains 5 AE / 10 USD, and 3 AE / 12 USD), 1 losing
    // - top win should be the 5 AE / 10 USD trade (best by AE), not 3 AE / 12 USD
    // - win rate = 2/3 * 100 = 66.67%
    // - avg hold = 86400s (1 day)
    // - unrealized = 10 AE
    transactionRepository.query.mockResolvedValue([
      {
        top_win_ae: '5',
        top_win_usd: '10',
        winning_sells: '2',
        total_sells: '3',
        avg_hold_secs: '86400',
        unrealized_ae: '10',
        unrealized_usd: '20',
      },
    ]);

    const result = await service.calculateTradingStats(
      'ak_test',
      new Date('2026-01-01'),
      new Date('2026-01-31'),
    );

    // Both AE and USD values come from the same best-AE trade
    expect(result.topWin).toEqual({ ae: 5, usd: 10 });
    expect(result.unrealizedProfit).toEqual({ ae: 10, usd: 20 });
    expect(result.winRate).toBeCloseTo((2 / 3) * 100);
    expect(result.avgDurationSeconds).toBe(86400);
    expect(result.totalTrades).toBe(3);
    expect(result.winningTrades).toBe(2);
  });

  it('calculateTradingStats top_win ae/usd come from the same trade, not independent MAX', async () => {
    const { service, transactionRepository } = createService();

    // Trade A: gain_ae = 5, gain_usd = 8  (best by AE — should be top_win)
    // Trade B: gain_ae = 3, gain_usd = 15 (best by USD — must NOT be used for top_win_usd)
    // Independent MAX would give { ae: 5, usd: 15 } — wrong.
    // Correct result: { ae: 5, usd: 8 } (both from Trade A).
    transactionRepository.query.mockResolvedValue([
      {
        top_win_ae: '5',
        top_win_usd: '8', // paired with the 5 AE trade, not 15
        winning_sells: '2',
        total_sells: '2',
        avg_hold_secs: '3600',
        unrealized_ae: '0',
        unrealized_usd: '0',
      },
    ]);

    const result = await service.calculateTradingStats(
      'ak_test',
      new Date('2026-01-01'),
      new Date('2026-01-31'),
    );

    expect(result.topWin).toEqual({ ae: 5, usd: 8 });
  });

  it('calculateTradingStats returns zero win_rate when no sells in range', async () => {
    const { service, transactionRepository } = createService();

    transactionRepository.query.mockResolvedValue([
      {
        top_win_ae: '0',
        top_win_usd: '0',
        winning_sells: '0',
        total_sells: '0',
        avg_hold_secs: '0',
        unrealized_ae: '25',
        unrealized_usd: '50',
      },
    ]);

    const result = await service.calculateTradingStats(
      'ak_test',
      new Date('2026-01-01'),
      new Date('2026-01-31'),
    );

    expect(result.winRate).toBe(0);
    expect(result.totalTrades).toBe(0);
    expect(result.winningTrades).toBe(0);
    expect(result.topWin).toEqual({ ae: 0, usd: 0 });
    // Unrealized profit still computed even with no sells
    expect(result.unrealizedProfit).toEqual({ ae: 25, usd: 50 });
  });

  it('calculateTradingStats returns safe defaults when query returns no rows', async () => {
    const { service, transactionRepository } = createService();

    transactionRepository.query.mockResolvedValue([]);

    const result = await service.calculateTradingStats(
      'ak_test',
      new Date('2026-01-01'),
      new Date('2026-01-31'),
    );

    expect(result).toEqual({
      topWin: { ae: 0, usd: 0 },
      unrealizedProfit: { ae: 0, usd: 0 },
      winRate: 0,
      avgDurationSeconds: 0,
      totalTrades: 0,
      winningTrades: 0,
    });
  });
});

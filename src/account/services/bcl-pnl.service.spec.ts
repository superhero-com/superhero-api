import { BclPnlService } from './bcl-pnl.service';

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
    expect(result.pnls.ct_token_one).toEqual({
      current_unit_price: { ae: 5, usd: 10 },
      percentage: (8 / 12) * 100,
      invested: { ae: 12, usd: 24 },
      current_value: { ae: 20, usd: 40 },
      gain: { ae: 8, usd: 16 },
    });
    expect(result.pnls.ct_token_two).toEqual({
      current_unit_price: { ae: 8, usd: 16 },
      percentage: (10 / 6) * 100,
      invested: { ae: 6, usd: 12 },
      current_value: { ae: 16, usd: 32 },
      gain: { ae: 10, usd: 20 },
    });
    expect(result.totalCostBasisAe).toBe(18);
    expect(result.totalCostBasisUsd).toBe(36);
    expect(result.totalCurrentValueAe).toBe(36);
    expect(result.totalCurrentValueUsd).toBe(72);
    expect(result.totalGainAe).toBe(18);
    expect(result.totalGainUsd).toBe(36);
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

  it('preserves range-based pnl result semantics', async () => {
    const { service, transactionRepository } = createService();
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
      },
    ]);

    const result = await service.calculateTokenPnls('ak_test', 100, 50);

    expect(result.pnls.ct_range).toEqual({
      current_unit_price: { ae: 7, usd: 14 },
      percentage: (9 / 20) * 100,
      invested: { ae: 20, usd: 40 },
      current_value: { ae: 35, usd: 70 },
      gain: { ae: 9, usd: 18 },
    });
    expect(result.totalCostBasisAe).toBe(20);
    expect(result.totalCostBasisUsd).toBe(40);
    expect(result.totalCurrentValueAe).toBe(35);
    expect(result.totalCurrentValueUsd).toBe(70);
    expect(result.totalGainAe).toBe(9);
    expect(result.totalGainUsd).toBe(18);
  });
});

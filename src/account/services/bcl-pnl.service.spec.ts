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

  it('uses joined latest-price CTEs instead of correlated subqueries', async () => {
    const { service, transactionRepository } = createService();
    transactionRepository.query.mockResolvedValue([]);

    await service.calculateTokenPnls('ak_test', 100, 50);

    expect(transactionRepository.query).toHaveBeenCalledTimes(1);
    const [sql, params] = transactionRepository.query.mock.calls[0];

    expect(sql).toContain('WITH aggregated_holdings AS');
    expect(sql).toContain('latest_price_ae AS');
    expect(sql).toContain('latest_price_usd AS');
    expect(sql).toContain('DISTINCT ON (tx.sale_address)');
    expect(sql).toContain('INNER JOIN aggregated_holdings agg');
    expect(sql).toContain('LEFT JOIN latest_price_ae');
    expect(sql).toContain('LEFT JOIN latest_price_usd');
    expect(sql).not.toContain('tx2.sale_address = tx.sale_address');
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

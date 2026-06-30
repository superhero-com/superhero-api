import { DexTokenSummaryService } from './dex-token-summary.service';
import { DEX_CONTRACTS } from '../config/dex-contracts.config';

describe('DexTokenSummaryService', () => {
  const makePair = (
    address: string,
    token0Address: string,
    token1Address: string,
  ) =>
    ({
      address,
      token0: { address: token0Address, decimals: 18 },
      token1: { address: token1Address, decimals: 18 },
    }) as any;

  const setup = () => {
    const dexTokenSummaryRepository = {
      findOne: jest.fn(),
      create: jest.fn((value) => value),
      save: jest.fn((value) => Promise.resolve(value)),
    } as any;
    const dexTokenRepository = {
      findOne: jest.fn(),
    } as any;
    const pairQueryBuilder = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
    };
    const pairRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(pairQueryBuilder),
    } as any;
    const query = jest.fn((sql: string) => {
      if (sql.includes('start_ratio')) {
        return Promise.resolve([{ start_ratio: '1', current_ratio: '2' }]);
      }
      return Promise.resolve([{ total_volume: '1' }]);
    });
    const release = jest.fn().mockResolvedValue(undefined);
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue({
        query,
        release,
      }),
    } as any;
    const aePricingService = {
      getPriceData: jest.fn().mockResolvedValue({ ae: '1' }),
    } as any;
    const dexTokenService = {
      getTokenPriceWithLiquidityAnalysis: jest.fn().mockResolvedValue({
        // Summary uses the deepest-path `price`, not the (poisoned) median.
        price: '2',
      }),
    } as any;

    const service = new DexTokenSummaryService(
      dexTokenSummaryRepository,
      dexTokenRepository,
      pairRepository,
      dataSource,
      aePricingService,
      dexTokenService,
    );

    return {
      service,
      dexTokenSummaryRepository,
      dexTokenRepository,
      pairRepository,
      dexTokenService,
      query,
      release,
    };
  };

  it('reuses supplied price cache and allPairs during summary generation', async () => {
    const {
      service,
      dexTokenSummaryRepository,
      dexTokenRepository,
      pairRepository,
      dexTokenService,
    } = setup();
    const tokenAddress = 'ct_token';
    const allPairs = [
      makePair('ct_pair_1', tokenAddress, 'ct_other_1'),
      makePair('ct_pair_2', tokenAddress, 'ct_other_2'),
    ];
    const priceCache = new Map<string, Promise<string | null>>();

    dexTokenRepository.findOne.mockResolvedValue({ address: tokenAddress });
    dexTokenSummaryRepository.findOne.mockResolvedValue(null);

    await service.createOrUpdateSummary(tokenAddress, { allPairs, priceCache });
    await service.createOrUpdateSummary(tokenAddress, { allPairs, priceCache });

    expect(pairRepository.createQueryBuilder).not.toHaveBeenCalled();
    expect(
      dexTokenService.getTokenPriceWithLiquidityAnalysis,
    ).toHaveBeenCalledTimes(1);
    expect(
      dexTokenService.getTokenPriceWithLiquidityAnalysis,
    ).toHaveBeenCalledWith(tokenAddress, expect.any(String), { allPairs });
    expect(priceCache.has(tokenAddress)).toBe(true);
  });

  it('normalizes the raw start-ratio to a human price before the % change', async () => {
    const tokenAddress = 'ct_token';
    // token0 = 6-decimal token, token1 = WAE (18 dp).
    const pair = {
      address: 'ct_pair',
      token0: { address: tokenAddress, decimals: 6 },
      token1: { address: DEX_CONTRACTS.wae, decimals: 18 },
    } as any;

    const dexTokenSummaryRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((v) => v),
      save: jest.fn((v) => Promise.resolve(v)),
    } as any;
    const dexTokenRepository = {
      findOne: jest.fn().mockResolvedValue({ address: tokenAddress }),
    } as any;
    const pairRepository = { createQueryBuilder: jest.fn() } as any;
    const query = jest.fn((sql: string) => {
      // raw ratio1 = 5e11 → human price = 5e11 * 10^(6-18) = 0.5
      if (sql.includes('start_ratio')) {
        return Promise.resolve([{ start_ratio: '500000000000' }]);
      }
      return Promise.resolve([{ total_volume: '0' }]);
    });
    const dataSource = {
      createQueryRunner: jest
        .fn()
        .mockReturnValue({ query, release: jest.fn() }),
    } as any;
    const aePricingService = {
      getPriceData: jest.fn().mockResolvedValue({ ae: 0 }),
    } as any;
    const dexTokenService = {
      getTokenPriceWithLiquidityAnalysis: jest
        .fn()
        .mockResolvedValue({ price: '0.6' }),
    } as any;

    const service = new DexTokenSummaryService(
      dexTokenSummaryRepository,
      dexTokenRepository,
      pairRepository,
      dataSource,
      aePricingService,
      dexTokenService,
    );

    const saved: any = await service.createOrUpdateSummary(tokenAddress, {
      allPairs: [pair],
    });

    // startPrice normalized to 0.5, currentPrice 0.6 → (0.6-0.5)/0.5*100 = 20.
    // Without normalization it would be ~ (0.6 - 5e11)/5e11 ≈ -100 (garbage).
    expect(saved.change['24h'].percentage).toBe('20');
  });

  it('skips a dust-state start ratio and reports no change rather than a garbage %', async () => {
    const tokenAddress = 'ct_token';
    // 18/18 pair, so the raw start_ratio normalizes 1:1. A 5e17 dust artifact
    // must be ignored — the % stays 0 instead of a multi-million-percent swing.
    const pair = {
      address: 'ct_pair',
      token0: { address: tokenAddress, decimals: 18 },
      token1: { address: DEX_CONTRACTS.wae, decimals: 18 },
    } as any;

    const dexTokenSummaryRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((v) => v),
      save: jest.fn((v) => Promise.resolve(v)),
    } as any;
    const dexTokenRepository = {
      findOne: jest.fn().mockResolvedValue({ address: tokenAddress }),
    } as any;
    const pairRepository = { createQueryBuilder: jest.fn() } as any;
    const query = jest.fn((sql: string) => {
      if (sql.includes('start_ratio')) {
        return Promise.resolve([{ start_ratio: '500000000000000000' }]);
      }
      return Promise.resolve([{ total_volume: '0' }]);
    });
    const dataSource = {
      createQueryRunner: jest
        .fn()
        .mockReturnValue({ query, release: jest.fn() }),
    } as any;
    const aePricingService = {
      getPriceData: jest.fn().mockResolvedValue({ ae: 0 }),
    } as any;
    const dexTokenService = {
      getTokenPriceWithLiquidityAnalysis: jest
        .fn()
        .mockResolvedValue({ price: '2' }),
    } as any;

    const service = new DexTokenSummaryService(
      dexTokenSummaryRepository,
      dexTokenRepository,
      pairRepository,
      dataSource,
      aePricingService,
      dexTokenService,
    );

    const saved: any = await service.createOrUpdateSummary(tokenAddress, {
      allPairs: [pair],
    });

    expect(saved.change['24h'].percentage).toBe('0.00');
  });

  it('reports 0% change for WAE — wrapped AE is always 1 AE', async () => {
    const tokenAddress = DEX_CONTRACTS.wae;
    // WAE (token0) / IMAE (token1). The pool's start ratio (~0.003) must NOT be
    // used as WAE's start price — WAE's AE price is constant 1, so change is 0.
    const pair = {
      address: 'ct_wae_imae',
      token0: { address: DEX_CONTRACTS.wae, decimals: 18 },
      token1: { address: 'ct_imae', decimals: 18 },
    } as any;

    const dexTokenSummaryRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((v) => v),
      save: jest.fn((v) => Promise.resolve(v)),
    } as any;
    const dexTokenRepository = {
      findOne: jest.fn().mockResolvedValue({ address: tokenAddress }),
    } as any;
    const pairRepository = { createQueryBuilder: jest.fn() } as any;
    const query = jest.fn((sql: string) => {
      if (sql.includes('start_ratio')) {
        // Must never be consulted for WAE's start price.
        return Promise.resolve([{ start_ratio: '0.003' }]);
      }
      return Promise.resolve([{ total_volume: '0' }]);
    });
    const dataSource = {
      createQueryRunner: jest
        .fn()
        .mockReturnValue({ query, release: jest.fn() }),
    } as any;
    const aePricingService = {
      getPriceData: jest.fn().mockResolvedValue({ ae: 0 }),
    } as any;
    const dexTokenService = {
      getTokenPriceWithLiquidityAnalysis: jest.fn(),
    } as any;

    const service = new DexTokenSummaryService(
      dexTokenSummaryRepository,
      dexTokenRepository,
      pairRepository,
      dataSource,
      aePricingService,
      dexTokenService,
    );

    const saved: any = await service.createOrUpdateSummary(tokenAddress, {
      allPairs: [pair],
    });

    expect(saved.change['24h'].percentage).toBe('0');
    // WAE price is short-circuited to 1, so no path analysis is needed.
    expect(
      dexTokenService.getTokenPriceWithLiquidityAnalysis,
    ).not.toHaveBeenCalled();
  });

  it('computes AE volume from the WAE side directly, not token × per-tx reserve ratio', async () => {
    const tokenAddress = 'ct_aec';
    // WAE (token0) / AEC (token1), both 18 dp. AE volume must be the WAE leg
    // taken directly — never AEC volume × (reserve0/reserve1), which explodes
    // for dust-reserve transactions (this token showed an inflated 4.8M AE).
    const pair = {
      address: 'ct_wae_aec',
      token0: { address: DEX_CONTRACTS.wae, decimals: 18 },
      token1: { address: tokenAddress, decimals: 18 },
    } as any;

    const dexTokenSummaryRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((v) => v),
      save: jest.fn((v) => Promise.resolve(v)),
    } as any;
    const dexTokenRepository = {
      findOne: jest.fn().mockResolvedValue({ address: tokenAddress }),
    } as any;
    const pairRepository = { createQueryBuilder: jest.fn() } as any;
    const query = jest.fn((sql: string) => {
      if (sql.includes('start_ratio')) {
        return Promise.resolve([{ start_ratio: '1' }]);
      }
      // Single grouped volume query: WAE leg (vol0) = 123 * 1e18 raw → 123 AE.
      return Promise.resolve([
        {
          pair_address: 'ct_wae_aec',
          vol0_total: '123000000000000000000',
          vol1_total: '999000000000000000000',
          vol0_24h: '0',
          vol1_24h: '0',
          vol0_7d: '0',
          vol1_7d: '0',
          vol0_30d: '0',
          vol1_30d: '0',
        },
      ]);
    });
    const dataSource = {
      createQueryRunner: jest
        .fn()
        .mockReturnValue({ query, release: jest.fn() }),
    } as any;
    const aePricingService = {
      getPriceData: jest.fn((v) => Promise.resolve({ ae: v.toString() })),
    } as any;
    const dexTokenService = {
      getTokenPriceWithLiquidityAnalysis: jest
        .fn()
        .mockResolvedValue({ price: '1' }),
    } as any;

    const service = new DexTokenSummaryService(
      dexTokenSummaryRepository,
      dexTokenRepository,
      pairRepository,
      dataSource,
      aePricingService,
      dexTokenService,
    );

    const saved: any = await service.createOrUpdateSummary(tokenAddress, {
      allPairs: [pair],
    });

    // Volume = the WAE leg (vol0/1e18 = 123), NOT the AEC leg (vol1) nor a
    // ratio-inflated number.
    expect(saved.total_volume.ae).toBe('123');
    // No volume query may reconstruct via reserves (the dust-prone path).
    const volumeSqls = query.mock.calls
      .map((c) => c[0] as string)
      .filter((sql) => sql.includes('vol0_total'));
    expect(volumeSqls.length).toBeGreaterThan(0);
    volumeSqls.forEach((sql) => expect(sql).not.toContain('pt.reserve'));
  });

  it('collapses the per-pair volume fan-out into a single grouped query and converts AEX9 volume in JS', async () => {
    const tokenAddress = 'ct_token';
    const otherAddress = 'ct_other'; // not WAE → AEX9/AEX9 pair
    // Two AEX9/AEX9 pairs for the same token, 6-decimal token side.
    const pairs = [
      {
        address: 'ct_pair_1',
        token0: { address: tokenAddress, decimals: 6 },
        token1: { address: otherAddress, decimals: 18 },
      },
      {
        address: 'ct_pair_2',
        token0: { address: otherAddress, decimals: 18 },
        token1: { address: tokenAddress, decimals: 6 },
      },
    ] as any;

    const dexTokenSummaryRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((v) => v),
      save: jest.fn((v) => Promise.resolve(v)),
    } as any;
    const dexTokenRepository = {
      findOne: jest.fn().mockResolvedValue({ address: tokenAddress }),
    } as any;
    const pairRepository = { createQueryBuilder: jest.fn() } as any;
    const query = jest.fn((sql: string) => {
      if (sql.includes('start_ratio')) {
        return Promise.resolve([{ start_ratio: '1' }]);
      }
      // One grouped row per pair. Token side is token0 (pair_1) / token1
      // (pair_2), each 6dp. 2_000_000 raw / 1e6 = 2 tokens; 1_000_000 raw = 1.
      return Promise.resolve([
        {
          pair_address: 'ct_pair_1',
          vol0_total: '2000000',
          vol1_total: '0',
          vol0_24h: '2000000',
          vol1_24h: '0',
          vol0_7d: '0',
          vol1_7d: '0',
          vol0_30d: '0',
          vol1_30d: '0',
        },
        {
          pair_address: 'ct_pair_2',
          vol0_total: '0',
          vol1_total: '1000000',
          vol0_24h: '0',
          vol1_24h: '0',
          vol0_7d: '0',
          vol1_7d: '0',
          vol0_30d: '0',
          vol1_30d: '0',
        },
      ]);
    });
    const dataSource = {
      createQueryRunner: jest
        .fn()
        .mockReturnValue({ query, release: jest.fn() }),
    } as any;
    const aePricingService = {
      getPriceData: jest.fn((v) => Promise.resolve({ ae: v.toString() })),
    } as any;
    const dexTokenService = {
      // Token's AE price = 3.
      getTokenPriceWithLiquidityAnalysis: jest
        .fn()
        .mockResolvedValue({ price: '3' }),
    } as any;

    const service = new DexTokenSummaryService(
      dexTokenSummaryRepository,
      dexTokenRepository,
      pairRepository,
      dataSource,
      aePricingService,
      dexTokenService,
    );

    const saved: any = await service.createOrUpdateSummary(tokenAddress, {
      allPairs: pairs,
    });

    // Exactly one volume query for the whole token (not 2 pairs × 4 windows).
    const volumeCalls = query.mock.calls.filter((c) =>
      String(c[0]).includes('vol0_total'),
    );
    expect(volumeCalls).toHaveLength(1);
    const volSql = String(volumeCalls[0][0]);
    expect(volSql).toContain('ANY($1)');
    expect(volSql).toContain('GROUP BY pt.pair_address');
    expect(volSql).toContain('FILTER (WHERE pt.created_at');
    // No per-pair joins to dex_tokens for decimals (done in JS now).
    expect(volSql).not.toContain('INNER JOIN dex_tokens');

    // total = (2 tokens × 3) + (1 token × 3) = 9 AE.
    expect(saved.total_volume.ae).toBe('9');
    // 24h window only had pair_1's 2 tokens × 3 = 6 AE.
    expect(saved.change['24h'].volume.ae).toBe('6');
    expect(saved.change['7d'].volume.ae).toBe('0');
  });
});

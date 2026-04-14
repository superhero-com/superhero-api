import { DexTokenService } from './dex-token.service';

describe('DexTokenService', () => {
  const makePair = (
    address: string,
    token0Address: string,
    token1Address: string,
    ratio0: number,
    ratio1: number,
    reserve0 = '100',
    reserve1 = '100',
  ) =>
    ({
      address,
      token0: { address: token0Address },
      token1: { address: token1Address },
      ratio0,
      ratio1,
      reserve0,
      reserve1,
    }) as any;

  const setup = () => {
    const service = new DexTokenService({} as any, {} as any);
    return { service };
  };

  it('uses supplied allPairs instead of loading from DB', async () => {
    const { service } = setup();
    const allPairs = [makePair('ct_pair', 'ct_token', 'ct_wae', 0.5, 2)];

    const loadPairsSpy = jest.spyOn(service, 'getAllPairsWithTokens');

    const result = await service.getTokenPriceWithLiquidityAnalysis(
      'ct_token',
      'ct_wae',
      { allPairs },
    );

    expect(loadPairsSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      price: '2',
      medianPrice: '2',
    });
    expect(result?.bestPath).toHaveLength(1);
    expect(result?.allPaths).toHaveLength(1);
    expect(result?.allPaths[0]).toMatchObject({
      price: '2',
      liquidity: expect.any(Number),
      confidence: expect.any(Number),
    });
  });

  it('returns detailed path analysis with multi-hop paths', async () => {
    const { service } = setup();
    const allPairs = [
      makePair('ct_pair_direct', 'ct_token', 'ct_wae', 0.5, 2, '200', '200'),
      makePair('ct_pair_hop_1', 'ct_token', 'ct_mid', 4, 0.25, '50', '50'),
      makePair('ct_pair_hop_2', 'ct_mid', 'ct_wae', 0.5, 2, '50', '50'),
    ];

    const result = await service.getTokenPriceWithLiquidityAnalysis(
      'ct_token',
      'ct_wae',
      { allPairs },
    );

    expect(result?.bestPath).toHaveLength(1);
    expect(result?.allPaths).toHaveLength(2);
    expect(result?.allPaths[0]).toMatchObject({
      path: expect.any(Array),
      price: expect.any(String),
      liquidity: expect.any(Number),
      confidence: expect.any(Number),
    });
  });
});

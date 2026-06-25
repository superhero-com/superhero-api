import { paginate } from 'nestjs-typeorm-paginate';
import { DexTokenService } from './dex-token.service';
import { DEX_CONTRACTS } from '../config/dex-contracts.config';

jest.mock('nestjs-typeorm-paginate');

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

  describe('findBestPairForToken', () => {
    it('returns null when the token has no pairs', async () => {
      const { service } = setup();
      jest
        .spyOn(service, 'getAllPairsWithTokens')
        .mockResolvedValue([
          makePair('ct_other', 'ct_a', 'ct_b', 1, 1),
        ] as any);

      expect(await service.findBestPairForToken('ct_token')).toBeNull();
    });

    it('prefers a WAE pair and quotes the token against WAE (basePosition)', async () => {
      const { service } = setup();
      // Deepest pool is a non-WAE pair, but a WAE pair exists and must win.
      jest.spyOn(service, 'getAllPairsWithTokens').mockResolvedValue([
        makePair('ct_deep_nonwae', 'ct_token', 'ct_mid', 1, 1, '999', '999'),
        makePair(
          'ct_wae_pair',
          'ct_token',
          DEX_CONTRACTS.wae,
          1,
          1,
          '100',
          '100',
        ),
      ] as any);

      const best = await service.findBestPairForToken('ct_token');

      expect(best?.pair.address).toBe('ct_wae_pair');
      // token is token0, so the base (quote) token is token1 (WAE).
      expect(best?.basePosition).toBe('token1');
    });

    it('falls back to the deepest pool when no WAE pair exists', async () => {
      const { service } = setup();
      jest.spyOn(service, 'getAllPairsWithTokens').mockResolvedValue([
        makePair('ct_shallow', 'ct_mid', 'ct_token', 1, 1, '10', '10'),
        makePair('ct_deep', 'ct_mid', 'ct_token', 1, 1, '500', '500'),
      ] as any);

      const best = await service.findBestPairForToken('ct_token');

      expect(best?.pair.address).toBe('ct_deep');
      // token is token1, so the base (quote) token is token0.
      expect(best?.basePosition).toBe('token0');
    });
  });

  describe('setListed', () => {
    it('returns null when the token does not exist', async () => {
      const repository = { findOne: jest.fn().mockResolvedValue(null), save: jest.fn() };
      const service = new DexTokenService(repository as any, {} as any);

      expect(await service.setListed('ct_missing', true)).toBeNull();
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('updates and persists the listed flag', async () => {
      const token = { address: 'ct_token', listed: false };
      const repository = {
        findOne: jest.fn().mockResolvedValue(token),
        save: jest.fn().mockImplementation((t) => Promise.resolve(t)),
      };
      const service = new DexTokenService(repository as any, {} as any);

      const result = await service.setListed('ct_token', true);

      expect(result?.listed).toBe(true);
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ address: 'ct_token', listed: true }),
      );
    });
  });

  describe('findAll listed filter', () => {
    const makeQb = () => {
      const qb: any = {};
      qb.leftJoinAndSelect = jest.fn(() => qb);
      qb.andWhere = jest.fn(() => qb);
      qb.orderBy = jest.fn(() => qb);
      return qb;
    };

    beforeEach(() => {
      (paginate as jest.Mock).mockReset();
      (paginate as jest.Mock).mockResolvedValue({ items: [], meta: {} });
    });

    it('filters by listed when the flag is provided', async () => {
      const qb = makeQb();
      const repository = { createQueryBuilder: jest.fn(() => qb) };
      const service = new DexTokenService(repository as any, {} as any);

      await service.findAll(
        { page: 1, limit: 100 },
        '',
        'created_at',
        'DESC',
        true,
      );

      expect(qb.andWhere).toHaveBeenCalledWith('dexToken.listed = :listed', {
        listed: true,
      });
    });

    it('does not filter by listed when the flag is omitted', async () => {
      const qb = makeQb();
      const repository = { createQueryBuilder: jest.fn(() => qb) };
      const service = new DexTokenService(repository as any, {} as any);

      await service.findAll({ page: 1, limit: 100 }, '', 'created_at', 'DESC');

      const listedClauses = qb.andWhere.mock.calls.filter((call: any[]) =>
        String(call[0]).includes('listed'),
      );
      expect(listedClauses).toHaveLength(0);
    });
  });
});

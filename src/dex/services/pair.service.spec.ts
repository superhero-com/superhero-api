import { paginate } from 'nestjs-typeorm-paginate';
import { PairService } from './pair.service';

jest.mock('nestjs-typeorm-paginate');

describe('PairService', () => {
  const makeQb = () => {
    const qb: any = {};
    qb.leftJoinAndSelect = jest.fn(() => qb);
    qb.loadRelationCountAndMap = jest.fn(() => qb);
    qb.orderBy = jest.fn(() => qb);
    qb.andWhere = jest.fn(() => qb);
    return qb;
  };

  const setup = () => {
    const qb = makeQb();
    const repository = { createQueryBuilder: jest.fn(() => qb) };
    const service = new PairService(repository as any, {} as any);
    return { service, repository, qb };
  };

  beforeEach(() => {
    (paginate as jest.Mock).mockReset();
    (paginate as jest.Mock).mockResolvedValue({ items: [], meta: {} });
  });

  it('clamps an oversized limit and a zero page before paginating (no hard reject)', async () => {
    const { service } = setup();

    await service.findAll(
      { page: 0, limit: 100000 } as any,
      'created_at',
      'DESC',
    );

    const opts = (paginate as jest.Mock).mock.calls[0][1];
    expect(opts.limit).toBe(100);
    expect(opts.page).toBe(1);
  });

  it('rejects an invalid order_by before touching the database', async () => {
    const { service, repository } = setup();

    await expect(
      service.findAll({ page: 1, limit: 10 } as any, 'drop_table'),
    ).rejects.toThrow();

    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  describe('factory lookups', () => {
    const setupFactory = () => {
      const ctx = setup();
      const factory = { get_pair: jest.fn(), get_all_pairs: jest.fn() };
      (ctx.service as any).factoryContract = factory;
      return { ...ctx, factory };
    };

    it('caches a factory pair under both token orders', async () => {
      const { service, factory } = setupFactory();
      factory.get_pair.mockResolvedValue({ decodedResult: 'ct_pair' });

      await expect(service.getFactoryPairAddress('ct_a', 'ct_b')).resolves.toBe(
        'ct_pair',
      );
      await expect(service.getFactoryPairAddress('ct_b', 'ct_a')).resolves.toBe(
        'ct_pair',
      );

      expect(factory.get_pair).toHaveBeenCalledTimes(1);
    });

    it('returns null for a missing pair and asks again next time', async () => {
      const { service, factory } = setupFactory();
      factory.get_pair.mockResolvedValue({ decodedResult: undefined });

      await expect(
        service.getFactoryPairAddress('ct_a', 'ct_b'),
      ).resolves.toBeNull();
      await service.getFactoryPairAddress('ct_a', 'ct_b');

      expect(factory.get_pair).toHaveBeenCalledTimes(2);
    });

    it('lists every factory pair', async () => {
      const { service, factory } = setupFactory();
      factory.get_all_pairs.mockResolvedValue({
        decodedResult: ['ct_p1', 'ct_p2'],
      });

      await expect(service.getFactoryPairAddresses()).resolves.toEqual(
        new Set(['ct_p1', 'ct_p2']),
      );
    });
  });

  describe('syncPairFromChain', () => {
    const tokenA = { address: 'ct_a' } as any;
    const tokenB = { address: 'ct_b' } as any;

    const setupChain = () => {
      const qb = makeQb();
      const repository = {
        createQueryBuilder: jest.fn(() => qb),
        save: jest.fn((pair) => Promise.resolve(pair)),
      };
      const service = new PairService(repository as any, {} as any);
      const pairContract = {
        token0: jest.fn().mockResolvedValue({ decodedResult: 'ct_a' }),
        token1: jest.fn().mockResolvedValue({ decodedResult: 'ct_b' }),
        total_supply: jest.fn().mockResolvedValue({ decodedResult: 30n }),
        get_reserves: jest.fn().mockResolvedValue({
          decodedResult: { reserve0: 10n, reserve1: 20n },
        }),
      };
      jest
        .spyOn(service, 'getPairContract')
        .mockResolvedValue(pairContract as any);
      return { service, repository, pairContract };
    };

    it('stores fresh reserves for a pair already in chain order', async () => {
      const { service, repository } = setupChain();

      await service.syncPairFromChain({
        address: 'ct_pair',
        token0: tokenA,
        token1: tokenB,
      } as any);

      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          token0: tokenA,
          token1: tokenB,
          reserve0: '10',
          reserve1: '20',
          total_supply: '30',
        }),
      );
    });

    it('swaps tokens stored in the caller order back to the pair order', async () => {
      const { service, repository } = setupChain();

      await service.syncPairFromChain({
        address: 'ct_pair',
        token0: tokenB,
        token1: tokenA,
      } as any);

      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ token0: tokenA, token1: tokenB }),
      );
    });

    it('refuses a row whose tokens are not the pair tokens', async () => {
      const { service, repository } = setupChain();

      await expect(
        service.syncPairFromChain({
          address: 'ct_pair',
          token0: tokenA,
          token1: { address: 'ct_c' },
        } as any),
      ).rejects.toThrow('stored as ct_a/ct_c but holds ct_a/ct_b');
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('reads the pair tokens from the chain once', async () => {
      const { service, pairContract } = setupChain();
      const pair = () =>
        ({ address: 'ct_pair', token0: tokenA, token1: tokenB }) as any;

      await service.syncPairFromChain(pair());
      await service.syncPairFromChain(pair());

      expect(pairContract.token0).toHaveBeenCalledTimes(1);
      expect(pairContract.get_reserves).toHaveBeenCalledTimes(2);
    });
  });

  describe('getAllPairsForPathFinding', () => {
    it('reuses the cached pairs within the TTL instead of re-querying', async () => {
      const { service, repository, qb } = setup();
      qb.getMany = jest.fn(() => Promise.resolve([{ address: 'pair1' }]));

      const first = await service.getAllPairsForPathFinding();
      const second = await service.getAllPairsForPathFinding();

      expect(repository.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(first).toBe(second);
      expect(first).toEqual([{ address: 'pair1' }]);
    });

    it('re-queries once the cache TTL expires', async () => {
      const { service, repository, qb } = setup();
      qb.getMany = jest.fn(() => Promise.resolve([{ address: 'pair1' }]));
      const nowSpy = jest.spyOn(Date, 'now');

      nowSpy.mockReturnValue(1_000_000);
      await service.getAllPairsForPathFinding();
      nowSpy.mockReturnValue(1_000_000 + 30_000);
      await service.getAllPairsForPathFinding();

      expect(repository.createQueryBuilder).toHaveBeenCalledTimes(2);
      nowSpy.mockRestore();
    });
  });
});

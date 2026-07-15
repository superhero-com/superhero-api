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

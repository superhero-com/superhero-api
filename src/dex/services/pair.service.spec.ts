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
});

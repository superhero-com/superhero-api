import { BadRequestException } from '@nestjs/common';
import { paginate } from 'nestjs-typeorm-paginate';
import { PairTransactionService } from './pair-transaction.service';

jest.mock('nestjs-typeorm-paginate');

describe('PairTransactionService', () => {
  const makeQb = () => {
    const qb: any = {};
    qb.leftJoinAndSelect = jest.fn(() => qb);
    qb.andWhere = jest.fn(() => qb);
    qb.orderBy = jest.fn(() => qb);
    return qb;
  };

  const setup = () => {
    const qb = makeQb();
    const repository = {
      createQueryBuilder: jest.fn(() => qb),
    };
    const service = new PairTransactionService(repository as any);
    return { service, repository, qb };
  };

  beforeEach(() => {
    (paginate as jest.Mock).mockReset();
    (paginate as jest.Mock).mockResolvedValue({ items: [], meta: {} });
  });

  it('rejects an invalid order_by before touching the database', async () => {
    const { service, repository } = setup();

    await expect(
      service.findAll({ page: 1, limit: 100 }, 'drop_table'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('rejects an invalid from_date before touching the database', async () => {
    const { service, repository } = setup();

    await expect(
      service.findAll(
        { page: 1, limit: 100 },
        'created_at',
        'DESC',
        undefined,
        undefined,
        undefined,
        undefined,
        'not-a-date',
      ),
    ).rejects.toThrow(/Invalid from_date/);

    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('rejects an invalid to_date before touching the database', async () => {
    const { service } = setup();

    await expect(
      service.findAll(
        { page: 1, limit: 100 },
        'created_at',
        'DESC',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'nope',
      ),
    ).rejects.toThrow(/Invalid to_date/);
  });

  it('applies created_at range filters when valid dates are provided', async () => {
    const { service, qb } = setup();

    const result = await service.findAll(
      { page: 1, limit: 100 },
      'created_at',
      'DESC',
      undefined,
      undefined,
      undefined,
      undefined,
      '2024-01-01T00:00:00.000Z',
      '2024-02-01T00:00:00.000Z',
    );

    expect(qb.andWhere).toHaveBeenCalledWith(
      'pairTransaction.created_at >= :fromDate',
      expect.objectContaining({ fromDate: expect.any(Date) }),
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      'pairTransaction.created_at <= :toDate',
      expect.objectContaining({ toDate: expect.any(Date) }),
    );
    expect(result).toEqual({ items: [], meta: {} });
  });

  it('does not add date filters when no dates are provided', async () => {
    const { service, qb } = setup();

    await service.findAll({ page: 1, limit: 100 });

    const dateClauses = qb.andWhere.mock.calls.filter((call: any[]) =>
      String(call[0]).includes('created_at'),
    );
    expect(dateClauses).toHaveLength(0);
  });
});

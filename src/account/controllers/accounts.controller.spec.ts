import { AccountsController } from './accounts.controller';
import { paginate } from 'nestjs-typeorm-paginate';
import { NotFoundException } from '@nestjs/common';

jest.mock('nestjs-typeorm-paginate', () => ({
  paginate: jest.fn().mockResolvedValue({ items: [], meta: {} }),
}));

describe('AccountsController', () => {
  const createQueryBuilder = () => ({
    leftJoin: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
  });

  let controller: AccountsController;
  let accountRepository: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };
  let queryBuilder: ReturnType<typeof createQueryBuilder>;
  let accountService: {
    getChainNameForAccount: jest.Mock;
  };
  let profileReadService: {
    getProfile: jest.Mock;
  };

  beforeEach(() => {
    queryBuilder = createQueryBuilder();
    accountRepository = {
      createQueryBuilder: jest.fn(() => queryBuilder),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    };
    accountService = {
      getChainNameForAccount: jest.fn(),
    };
    profileReadService = {
      getProfile: jest.fn(),
    };

    controller = new AccountsController(
      accountRepository as any,
      {} as any,
      accountService as any,
      profileReadService as any,
    );
  });

  it('returns paginated accounts', async () => {
    const result = await controller.listAll(
      undefined,
      1,
      100,
      'total_volume',
      'DESC',
    );

    expect(accountRepository.createQueryBuilder).toHaveBeenCalledWith(
      'account',
    );
    expect(queryBuilder.leftJoin).not.toHaveBeenCalled();
    expect(queryBuilder.orderBy).toHaveBeenCalledWith(
      'account.total_volume',
      'DESC',
    );
    expect(paginate).toHaveBeenCalledWith(queryBuilder, {
      page: 1,
      limit: 100,
    });
    expect(result).toEqual({ items: [], meta: {} });
  });

  it('applies search across account addresses and names', async () => {
    await controller.listAll('alice', 1, 100, 'total_volume', 'DESC');

    expect(queryBuilder.leftJoin).toHaveBeenCalledWith(
      expect.any(Function),
      'profile_cache',
      'profile_cache.address = account.address',
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledTimes(1);
    const [whereClause, params] = queryBuilder.andWhere.mock.calls[0];

    expect(whereClause).toBeDefined();
    expect(params).toBeUndefined();
  });

  it('does not apply search for blank input', async () => {
    await controller.listAll('   ', 1, 100, 'total_volume', 'DESC');

    expect(queryBuilder.leftJoin).not.toHaveBeenCalled();
    expect(queryBuilder.andWhere).not.toHaveBeenCalled();
  });

  it('throws when account is missing', async () => {
    accountRepository.findOne.mockResolvedValue(null);

    await expect(controller.getAccount('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

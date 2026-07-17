import { SearchController } from './search.controller';

describe('SearchController', () => {
  let controller: SearchController;
  let tokensRepository: { createQueryBuilder: jest.Mock };
  let postsRepository: { createQueryBuilder: jest.Mock };
  let accountService: { searchByNameOrAddress: jest.Mock };
  let tokensQueryBuilder: {
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    limit: jest.Mock;
    getMany: jest.Mock;
  };
  let postsQueryBuilder: {
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    limit: jest.Mock;
    getMany: jest.Mock;
  };

  beforeEach(() => {
    tokensQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    postsQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    tokensRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(tokensQueryBuilder),
    };
    postsRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(postsQueryBuilder),
    };
    accountService = {
      searchByNameOrAddress: jest.fn().mockResolvedValue([]),
    };

    controller = new SearchController(
      tokensRepository as any,
      postsRepository as any,
      accountService as any,
    );
  });

  it('returns empty results without querying when q is blank', async () => {
    const result = await controller.search(undefined, 5);

    expect(result).toEqual({ tokens: [], accounts: [], posts: [] });
    expect(tokensRepository.createQueryBuilder).not.toHaveBeenCalled();
    expect(postsRepository.createQueryBuilder).not.toHaveBeenCalled();
    expect(accountService.searchByNameOrAddress).not.toHaveBeenCalled();
  });

  it('returns empty results without querying when q is shorter than the minimum length', async () => {
    const result = await controller.search('a', 5);

    expect(result).toEqual({ tokens: [], accounts: [], posts: [] });
    expect(tokensRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('rejects an overly long query', async () => {
    await expect(
      controller.search('a'.repeat(101), 5),
    ).rejects.toThrow('q must be at most 100 characters');
  });

  it('runs the three lookups in parallel, each capped at the clamped limit', async () => {
    const tokens = [{ sale_address: 'ct_1' }];
    const posts = [{ id: 'post_1' }];
    const accounts = [{ address: 'ak_1', chain_name: null }];
    tokensQueryBuilder.getMany.mockResolvedValue(tokens);
    postsQueryBuilder.getMany.mockResolvedValue(posts);
    accountService.searchByNameOrAddress.mockResolvedValue(accounts);

    const result = await controller.search('super', 500);

    expect(tokensQueryBuilder.where).toHaveBeenCalledWith(
      'token.unlisted = false',
    );
    expect(tokensQueryBuilder.andWhere).toHaveBeenCalledWith(
      'token.name ILIKE :term',
      { term: '%super%' },
    );
    expect(tokensQueryBuilder.limit).toHaveBeenCalledWith(20); // clamped to MAX_LIMIT

    expect(postsQueryBuilder.where).toHaveBeenCalledWith(
      'post.is_hidden = false',
    );
    expect(postsQueryBuilder.andWhere).toHaveBeenCalledWith(
      'post.content ILIKE :term',
      { term: '%super%' },
    );
    expect(postsQueryBuilder.limit).toHaveBeenCalledWith(20);

    expect(accountService.searchByNameOrAddress).toHaveBeenCalledWith(
      'super',
      20,
    );

    expect(result).toEqual({ tokens, accounts, posts });
  });
});

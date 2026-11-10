import { TrendingTagsController } from './trending-tags.controller';
import { paginate } from 'nestjs-typeorm-paginate';

jest.mock('nestjs-typeorm-paginate', () => ({
  paginate: jest.fn().mockResolvedValue({ items: [], meta: {} }),
}));

describe('TrendingTagsController', () => {
  let controller: TrendingTagsController;
  let trendingTagRepository: {
    createQueryBuilder: jest.Mock;
    manager: { query: jest.Mock };
  };
  let queryBuilder: {
    orderBy: jest.Mock;
    where: jest.Mock;
    leftJoinAndMapOne: jest.Mock;
  };

  beforeEach(() => {
    queryBuilder = {
      orderBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      leftJoinAndMapOne: jest.fn().mockReturnThis(),
    };

    trendingTagRepository = {
      createQueryBuilder: jest.fn(() => queryBuilder),
      manager: { query: jest.fn().mockResolvedValue([]) },
    };

    controller = new TrendingTagsController(
      trendingTagRepository as any,
      {} as any,
    );
  });

  it('applies search to trending tag names', async () => {
    await controller.listAll(1, 100, 'score', 'DESC', 'hero');

    expect(queryBuilder.where).toHaveBeenCalledWith(
      'trending_tag.tag ILIKE :search',
      { search: '%hero%' },
    );
    expect(paginate).toHaveBeenCalledWith(queryBuilder, {
      page: 1,
      limit: 100,
    });
  });

  it('gives the joined token its rank from token_rank', async () => {
    const token = { sale_address: 'ct_1' };
    (paginate as jest.Mock).mockResolvedValueOnce({
      items: [{ tag: 'HERO', token }, { tag: 'NOTOKEN' }],
      meta: {},
    });
    trendingTagRepository.manager.query.mockResolvedValue([
      { sale_address: 'ct_1', rank: 12 },
    ]);

    await controller.listAll(1, 100, 'score', 'DESC', '');

    expect(token).toHaveProperty('rank', 12);
  });
});

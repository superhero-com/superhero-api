import { TrendingTagsController } from './trending-tags.controller';
import { paginate } from 'nestjs-typeorm-paginate';

jest.mock('nestjs-typeorm-paginate', () => ({
  paginate: jest.fn().mockResolvedValue({ items: [], meta: {} }),
}));

describe('TrendingTagsController', () => {
  let controller: TrendingTagsController;
  let trendingTagRepository: {
    createQueryBuilder: jest.Mock;
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
});

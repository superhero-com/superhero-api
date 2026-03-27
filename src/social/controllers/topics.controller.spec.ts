import { TopicsController } from './topics.controller';
import { paginate } from 'nestjs-typeorm-paginate';

jest.mock('nestjs-typeorm-paginate', () => ({
  paginate: jest.fn().mockResolvedValue({ items: [], meta: {} }),
}));

describe('TopicsController', () => {
  let controller: TopicsController;
  let topicRepository: {
    createQueryBuilder: jest.Mock;
  };
  let queryBuilder: {
    where: jest.Mock;
    orderBy: jest.Mock;
  };

  beforeEach(() => {
    queryBuilder = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
    };

    topicRepository = {
      createQueryBuilder: jest.fn(() => queryBuilder),
    };

    controller = new TopicsController(topicRepository as any);
  });

  it('applies search to topic names', async () => {
    await controller.listAll(1, 50, 'post_count', 'DESC', 'governance');

    expect(queryBuilder.where).toHaveBeenCalledWith(
      'topic.name ILIKE :searchTerm',
      { searchTerm: '%governance%' },
    );
    expect(paginate).toHaveBeenCalledWith(queryBuilder, { page: 1, limit: 50 });
  });
});

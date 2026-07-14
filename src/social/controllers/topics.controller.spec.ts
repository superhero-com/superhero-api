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

  describe('lookup by name', () => {
    // Topics are written lowercased, so a lookup has to fold the caller's input
    // the same way or an uppercase Cyrillic tag never resolves.
    const lookupController = (found: unknown) => {
      const findOne = jest.fn().mockResolvedValue(found);
      return {
        findOne,
        controller: new TopicsController({ findOne } as any),
      };
    };

    it('folds an uppercase Cyrillic name onto the stored lowercase topic', async () => {
      const stored = { id: 'uuid-1', name: 'привет' };
      const { findOne, controller: c } = lookupController(stored);

      await expect(c.getByName('ПРИВЕТ')).resolves.toBe(stored);
      expect(findOne).toHaveBeenCalledWith({
        where: { name: 'привет' },
        relations: ['posts'],
      });
    });

    it('folds case for Latin names too, and trims', async () => {
      const stored = { id: 'uuid-2', name: 'governance' };
      const { findOne, controller: c } = lookupController(stored);

      await expect(c.getByName('  GoVeRnAnCe  ')).resolves.toBe(stored);
      expect(findOne).toHaveBeenCalledWith({
        where: { name: 'governance' },
        relations: ['posts'],
      });
    });

    it('passes caseless scripts through unchanged', async () => {
      const stored = { id: 'uuid-3', name: '汉字' };
      const { findOne, controller: c } = lookupController(stored);

      await expect(c.getByName('汉字')).resolves.toBe(stored);
      expect(findOne).toHaveBeenCalledWith({
        where: { name: '汉字' },
        relations: ['posts'],
      });
    });

    it('folds case on the name branch of getById as well', async () => {
      const stored = { id: 'uuid-4', name: 'привет' };
      const { findOne, controller: c } = lookupController(stored);

      await expect(c.getById('ПРИВЕТ')).resolves.toBe(stored);
      expect(findOne).toHaveBeenCalledWith({
        where: { name: 'привет' },
        relations: ['posts'],
      });
    });

    it('still treats a UUID as an id, not a name', async () => {
      const stored = { id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' };
      const { findOne, controller: c } = lookupController(stored);

      await c.getById('3F2504E0-4F89-11D3-9A0C-0305E82C3301');
      expect(findOne).toHaveBeenCalledWith({
        where: { id: '3F2504E0-4F89-11D3-9A0C-0305E82C3301' },
        relations: ['posts'],
      });
    });
  });
});

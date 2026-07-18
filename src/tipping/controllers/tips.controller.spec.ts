import { TipsController } from './tips.controller';
import { paginate } from 'nestjs-typeorm-paginate';

jest.mock('nestjs-typeorm-paginate', () => ({
  paginate: jest.fn().mockResolvedValue({ items: [], meta: {} }),
}));

describe('TipsController', () => {
  let controller: TipsController;
  let tipRepository: any;
  let postRepository: any;

  beforeEach(() => {
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({
        total_sent: '5',
        total_received: '7',
      }),
    };

    tipRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    postRepository = {
      findOne: jest.fn(),
    };

    controller = new TipsController(
      tipRepository as any,
      postRepository as any,
    );
  });

  it('excludes self-tips from account summary totals', async () => {
    const result = await controller.getAccountSummary('ak_account');

    const queryBuilder = tipRepository.createQueryBuilder.mock.results[0].value;

    expect(queryBuilder.select).toHaveBeenCalledWith(
      expect.stringContaining(
        'tip.sender_address = :address AND tip.sender_address != tip.receiver_address',
      ),
    );
    expect(queryBuilder.addSelect).toHaveBeenCalledWith(
      expect.stringContaining(
        'tip.receiver_address = :address AND tip.sender_address != tip.receiver_address',
      ),
    );
    expect(queryBuilder.setParameters).toHaveBeenCalledWith({
      address: 'ak_account',
    });
    expect(result).toEqual({
      totalTipsSent: '5',
      totalTipsReceived: '7',
    });
  });

  it('filters listTips by post_id when provided', async () => {
    const listQueryBuilder = {
      leftJoinAndMapOne: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
    };
    tipRepository.createQueryBuilder.mockReturnValue(listQueryBuilder);

    await controller.listTips(
      1,
      100,
      'created_at',
      'DESC',
      undefined,
      undefined,
      undefined,
      'post_123',
    );

    expect(listQueryBuilder.andWhere).toHaveBeenCalledWith(
      'tip.post_id = :postId',
      { postId: 'post_123' },
    );
    expect(paginate).toHaveBeenCalledWith(listQueryBuilder, {
      page: 1,
      limit: 100,
    });
  });

  it('does not filter listTips by post_id when absent', async () => {
    const listQueryBuilder = {
      leftJoinAndMapOne: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
    };
    tipRepository.createQueryBuilder.mockReturnValue(listQueryBuilder);

    await controller.listTips(1, 100, 'created_at', 'DESC');

    expect(listQueryBuilder.andWhere).not.toHaveBeenCalledWith(
      'tip.post_id = :postId',
      expect.anything(),
    );
  });
});

import { TipsController } from './tips.controller';

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
});

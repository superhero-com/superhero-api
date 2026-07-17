import { InvitationsController } from './invitations.controller';
import { paginate } from 'nestjs-typeorm-paginate';

jest.mock('nestjs-typeorm-paginate', () => ({
  paginate: jest.fn(),
}));

describe('InvitationsController', () => {
  let controller: InvitationsController;
  let invitationRepository: { createQueryBuilder: jest.Mock };
  let queryBuilder: {
    orderBy: jest.Mock;
    andWhere: jest.Mock;
    leftJoinAndMapOne: jest.Mock;
  };

  beforeEach(() => {
    queryBuilder = {
      orderBy: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      leftJoinAndMapOne: jest.fn().mockReturnThis(),
    };
    invitationRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    controller = new InvitationsController(invitationRepository as any);
    (paginate as jest.Mock).mockReset();
  });

  it('filters by inviter when provided', async () => {
    (paginate as jest.Mock).mockResolvedValue({ items: [], meta: {} });

    await controller.listAll(1, 100, 'amount', 'DESC', 'ak_inviter');

    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'invitation.sender_address = :inviter',
      { inviter: 'ak_inviter' },
    );
  });

  it('does not filter by inviter when absent', async () => {
    (paginate as jest.Mock).mockResolvedValue({ items: [], meta: {} });

    await controller.listAll(1, 100, 'amount', 'DESC');

    expect(queryBuilder.andWhere).not.toHaveBeenCalled();
  });

  it('annotates each item with derived claim status', async () => {
    (paginate as jest.Mock).mockResolvedValue({
      items: [
        {
          id: '1',
          status: 'claimed',
          invitee_address: 'ak_claimer',
          status_updated_at: new Date('2026-01-01'),
          claim_tx_hash: 'th_claim',
        },
        {
          id: '2',
          status: 'pending',
          invitee_address: null,
          status_updated_at: null,
          claim_tx_hash: null,
        },
        {
          id: '3',
          status: 'revoked',
          invitee_address: null,
          status_updated_at: new Date('2026-01-02'),
          claim_tx_hash: null,
        },
      ],
      meta: { totalItems: 3 },
    });

    const result = await controller.listAll(1, 100, 'amount', 'DESC');

    expect(result.items).toEqual([
      expect.objectContaining({
        id: '1',
        claimed: true,
        claimer_address: 'ak_claimer',
        claimed_at: new Date('2026-01-01'),
        claim_tx_hash: 'th_claim',
      }),
      expect.objectContaining({
        id: '2',
        claimed: false,
        claimer_address: null,
        claimed_at: null,
        claim_tx_hash: null,
      }),
      expect.objectContaining({
        id: '3',
        claimed: false,
        claimer_address: null,
        claimed_at: null,
        claim_tx_hash: null,
      }),
    ]);
    expect(result.meta).toEqual({ totalItems: 3 });
  });

  it('rejects an out-of-range limit', async () => {
    await expect(
      controller.listAll(1, 500, 'amount', 'DESC'),
    ).rejects.toThrow('Limit must be between 1 and 100');
  });
});

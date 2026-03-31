import { TipService } from './tips.service';

describe('TipService', () => {
  let service: TipService;
  let tipRepository: any;
  let postRepository: any;
  let accountRepository: any;
  let tokensService: any;

  beforeEach(() => {
    tipRepository = {
      findOne: jest.fn(),
      save: jest.fn(),
    };
    postRepository = {
      findOne: jest.fn(),
    };
    accountRepository = {};
    tokensService = {
      updateTrendingScoresForSymbols: jest.fn(),
    };

    service = new TipService(
      tipRepository as any,
      postRepository as any,
      accountRepository as any,
      tokensService as any,
    );
  });

  it('keeps the saved tip when trending refresh fails', async () => {
    const savedTip = { id: 1, tx_hash: 'th_tip' };

    tipRepository.findOne.mockResolvedValue(null);
    tipRepository.save.mockResolvedValue(savedTip);
    postRepository.findOne.mockResolvedValue({
      id: 'post-1',
      token_mentions: ['ALPHA'],
    });
    jest
      .spyOn(service as any, 'ensureAccountExists')
      .mockResolvedValueOnce({ address: 'ak_sender' })
      .mockResolvedValueOnce({ address: 'ak_receiver' });
    tokensService.updateTrendingScoresForSymbols.mockRejectedValue(
      new Error('refresh failed'),
    );

    const result = await service.saveTipFromTransaction(
      {
        hash: 'th_tip',
        tx: {
          senderId: 'ak_sender',
          recipientId: 'ak_receiver',
          amount: '1000000000000000000',
        },
      } as any,
      'TIP_POST:post-1' as any,
    );

    expect(result).toBe(savedTip);
    expect(tokensService.updateTrendingScoresForSymbols).toHaveBeenCalledWith([
      'ALPHA',
    ]);
  });

  it('does not persist self-tips on a post', async () => {
    tipRepository.findOne.mockResolvedValue(null);
    postRepository.findOne.mockResolvedValue({
      id: 'post-1',
      sender_address: 'ak_sender',
      token_mentions: ['ALPHA'],
    });
    const ensureAccountExists = jest.spyOn(
      service as any,
      'ensureAccountExists',
    );

    const result = await service.saveTipFromTransaction(
      {
        hash: 'th_self_tip',
        tx: {
          senderId: 'ak_sender',
          recipientId: 'ak_sender',
          amount: '1000000000000000000',
        },
      } as any,
      'TIP_POST:post-1' as any,
    );

    expect(result).toBeNull();
    expect(ensureAccountExists).not.toHaveBeenCalled();
    expect(tipRepository.save).not.toHaveBeenCalled();
    expect(tokensService.updateTrendingScoresForSymbols).not.toHaveBeenCalled();
  });

  it('does not persist self-tips on a profile', async () => {
    tipRepository.findOne.mockResolvedValue(null);
    const ensureAccountExists = jest.spyOn(
      service as any,
      'ensureAccountExists',
    );

    const result = await service.saveTipFromTransaction(
      {
        hash: 'th_self_tip_profile',
        tx: {
          senderId: 'ak_sender',
          recipientId: 'ak_sender',
          amount: '1000000000000000000',
        },
      } as any,
      'TIP_PROFILE' as any,
    );

    expect(result).toBeNull();
    expect(postRepository.findOne).not.toHaveBeenCalled();
    expect(ensureAccountExists).not.toHaveBeenCalled();
    expect(tipRepository.save).not.toHaveBeenCalled();
    expect(tokensService.updateTrendingScoresForSymbols).not.toHaveBeenCalled();
  });

  it('marks self-tips as skipped during live handling', async () => {
    jest
      .spyOn(service as any, 'validateTransaction')
      .mockReturnValue('TIP_POST:post-1');
    postRepository.findOne.mockResolvedValue({
      id: 'post-1',
      sender_address: 'ak_sender',
      token_mentions: ['ALPHA'],
    });

    const result = await service.handleLiveTransaction({
      hash: 'th_self_tip',
      tx: {
        senderId: 'ak_sender',
        recipientId: 'ak_sender',
        amount: '1000000000000000000',
      },
    } as any);

    expect(result).toEqual({
      success: false,
      skipped: true,
      reason: 'Self tip ignored',
    });
  });
});

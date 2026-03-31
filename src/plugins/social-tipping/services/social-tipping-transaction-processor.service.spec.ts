import { SocialTippingTransactionProcessorService } from './social-tipping-transaction-processor.service';

describe('SocialTippingTransactionProcessorService', () => {
  let service: SocialTippingTransactionProcessorService;
  let tipRepository: any;
  let postRepository: any;
  let tokensService: any;

  beforeEach(() => {
    tipRepository = {
      manager: {
        transaction: jest.fn(),
      },
    };
    postRepository = {
      findOne: jest.fn(),
    };
    tokensService = {
      updateTrendingScoresForSymbols: jest.fn().mockResolvedValue(undefined),
    };

    service = new SocialTippingTransactionProcessorService(
      tipRepository as any,
      {} as any,
      postRepository as any,
      tokensService as any,
    );
  });

  it('recalculates trending only after the tip transaction commits', async () => {
    const callOrder: string[] = [];

    jest
      .spyOn(service as any, 'validateTransaction')
      .mockReturnValue('TIP_POST:post-1');
    jest.spyOn(service as any, 'saveTipFromTransaction').mockResolvedValue({
      tip: { tx_hash: 'th_tip' },
      post: {
        sender_address: 'ak_receiver',
        token_mentions: ['ALPHA'],
        post_id: 'parent-1',
      },
    });

    postRepository.findOne.mockResolvedValue({
      token_mentions: ['BETA'],
    });
    tokensService.updateTrendingScoresForSymbols.mockImplementation(
      async () => {
        callOrder.push('recalculate');
      },
    );

    tipRepository.manager.transaction.mockImplementation(
      async (handler: any) => {
        callOrder.push('transaction-start');
        const result = await handler({});
        callOrder.push('transaction-commit');
        return result;
      },
    );

    const result = await service.processTransaction(
      {
        hash: 'th_tip',
        sender_id: 'ak_sender',
        recipient_id: 'ak_receiver',
      } as any,
      'live' as any,
    );

    expect(callOrder).toEqual([
      'transaction-start',
      'transaction-commit',
      'recalculate',
    ]);
    expect(tokensService.updateTrendingScoresForSymbols).toHaveBeenCalledWith([
      'ALPHA',
      'BETA',
    ]);
    expect(result).toEqual({ tx_hash: 'th_tip' });
  });

  it('keeps the saved tip when trending refresh fails', async () => {
    jest
      .spyOn(service as any, 'validateTransaction')
      .mockReturnValue('TIP_POST:post-1');
    jest.spyOn(service as any, 'saveTipFromTransaction').mockResolvedValue({
      tip: { tx_hash: 'th_tip' },
      post: { sender_address: 'ak_receiver', token_mentions: ['ALPHA'] },
    });
    tokensService.updateTrendingScoresForSymbols.mockRejectedValue(
      new Error('refresh failed'),
    );
    tipRepository.manager.transaction.mockImplementation(async (handler: any) =>
      handler({}),
    );

    const result = await service.processTransaction(
      {
        hash: 'th_tip',
        sender_id: 'ak_sender',
        recipient_id: 'ak_receiver',
      } as any,
      'live' as any,
    );

    expect(result).toEqual({ tx_hash: 'th_tip' });
    expect(tokensService.updateTrendingScoresForSymbols).toHaveBeenCalledWith([
      'ALPHA',
    ]);
  });

  it('skips persisting self-tips on a post', async () => {
    jest
      .spyOn(service as any, 'validateTransaction')
      .mockReturnValue('TIP_POST:post-1');
    jest
      .spyOn(service as any, 'saveTipFromTransaction')
      .mockResolvedValue(null);
    tipRepository.manager.transaction.mockImplementation(async (handler: any) =>
      handler({}),
    );

    const result = await service.processTransaction(
      {
        hash: 'th_tip',
        sender_id: 'ak_sender',
        recipient_id: 'ak_sender',
      } as any,
      'live' as any,
    );

    expect(result).toBeNull();
    expect(tokensService.updateTrendingScoresForSymbols).not.toHaveBeenCalled();
  });

  it('does not persist self-tips on a profile', async () => {
    const tipRepositoryMock = {
      upsert: jest.fn(),
      findOneOrFail: jest.fn(),
    };
    const accountRepositoryMock = {
      upsert: jest.fn(),
      findOne: jest.fn(),
    };
    const manager = {
      getRepository: jest.fn((entity: any) => {
        if (entity.name === 'Tip') {
          return tipRepositoryMock;
        }
        if (entity.name === 'Account') {
          return accountRepositoryMock;
        }
        return {
          findOne: jest.fn(),
        };
      }),
    };

    const ensureAccountExists = jest.spyOn(
      service as any,
      'ensureAccountExists',
    );

    const result = await (service as any).saveTipFromTransaction(
      {
        hash: 'th_tip',
        sender_id: 'ak_sender',
        recipient_id: 'ak_sender',
        raw: { amount: '1000000000000000000' },
      },
      'TIP_PROFILE',
      manager,
    );

    expect(result).toBeNull();
    expect(ensureAccountExists).not.toHaveBeenCalled();
    expect(tipRepositoryMock.upsert).not.toHaveBeenCalled();
    expect(tipRepositoryMock.findOneOrFail).not.toHaveBeenCalled();
  });

  it('does not persist self-tips on a post', async () => {
    const tipRepositoryMock = {
      upsert: jest.fn(),
      findOneOrFail: jest.fn(),
    };
    const accountRepositoryMock = {
      upsert: jest.fn(),
      findOne: jest.fn(),
    };
    const postRepositoryMock = {
      findOne: jest.fn().mockResolvedValue({
        id: 'post-1',
        sender_address: 'ak_sender',
      }),
    };
    const manager = {
      getRepository: jest.fn((entity: any) => {
        if (entity.name === 'Tip') {
          return tipRepositoryMock;
        }
        if (entity.name === 'Account') {
          return accountRepositoryMock;
        }
        return postRepositoryMock;
      }),
    };

    const ensureAccountExists = jest.spyOn(
      service as any,
      'ensureAccountExists',
    );

    const result = await (service as any).saveTipFromTransaction(
      {
        hash: 'th_tip',
        sender_id: 'ak_sender',
        recipient_id: 'ak_sender',
        raw: { amount: '1000000000000000000' },
      },
      'TIP_POST:post-1',
      manager,
    );

    expect(result).toBeNull();
    expect(postRepositoryMock.findOne).toHaveBeenCalledWith({
      where: { id: 'post-1' },
    });
    expect(ensureAccountExists).not.toHaveBeenCalled();
    expect(tipRepositoryMock.upsert).not.toHaveBeenCalled();
    expect(tipRepositoryMock.findOneOrFail).not.toHaveBeenCalled();
  });
});

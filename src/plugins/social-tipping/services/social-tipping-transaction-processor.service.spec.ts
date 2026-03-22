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
      post: { token_mentions: ['ALPHA'], post_id: 'parent-1' },
    });

    postRepository.findOne.mockResolvedValue({
      token_mentions: ['BETA'],
    });
    tokensService.updateTrendingScoresForSymbols.mockImplementation(async () => {
      callOrder.push('recalculate');
    });

    tipRepository.manager.transaction.mockImplementation(async (handler: any) => {
      callOrder.push('transaction-start');
      const result = await handler({});
      callOrder.push('transaction-commit');
      return result;
    });

    const result = await service.processTransaction(
      { hash: 'th_tip' } as any,
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
      post: { token_mentions: ['ALPHA'] },
    });
    tokensService.updateTrendingScoresForSymbols.mockRejectedValue(
      new Error('refresh failed'),
    );
    tipRepository.manager.transaction.mockImplementation(async (handler: any) =>
      handler({}),
    );

    const result = await service.processTransaction(
      { hash: 'th_tip' } as any,
      'live' as any,
    );

    expect(result).toEqual({ tx_hash: 'th_tip' });
    expect(tokensService.updateTrendingScoresForSymbols).toHaveBeenCalledWith([
      'ALPHA',
    ]);
  });
});

import { encode, Encoding } from '@aeternity/aepp-sdk';
import { SocialTippingTransactionProcessorService } from './social-tipping-transaction-processor.service';

describe('SocialTippingTransactionProcessorService', () => {
  let service: SocialTippingTransactionProcessorService;
  let tipRepository: any;
  let postRepository: any;
  let accountService: any;
  let tokensService: any;
  let eventEmitter: any;

  beforeEach(() => {
    eventEmitter = { emit: jest.fn() };
    tipRepository = {
      manager: {
        transaction: jest.fn(),
      },
    };
    postRepository = {
      findOne: jest.fn(),
    };
    accountService = {
      ensureAccountExists: jest.fn(),
    };
    tokensService = {
      queueTrendingScoresForSymbols: jest.fn().mockResolvedValue(undefined),
    };

    service = new SocialTippingTransactionProcessorService(
      tipRepository as any,
      accountService as any,
      postRepository as any,
      tokensService as any,
      eventEmitter as any,
    );
  });

  describe('tip-received event', () => {
    const tipTx = {
      hash: 'th_tip',
      sender_id: 'ak_sender',
      recipient_id: 'ak_receiver',
      raw: { amount: 1500000000000000000 },
    } as any;

    beforeEach(() => {
      jest
        .spyOn(service as any, 'validateTransaction')
        .mockReturnValue('TIP_POST:post-1');
      jest.spyOn(service as any, 'saveTipFromTransaction').mockResolvedValue({
        tip: { tx_hash: 'th_tip', amount: '1.5' },
        post: { id: 'post-1_v3', sender_address: 'ak_receiver' },
      });
      tipRepository.manager.transaction.mockImplementation(
        async (handler: any) => handler({}),
      );
    });

    it('emits after commit for a live tip', async () => {
      await service.processTransaction(tipTx, 'live' as any);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'social-tipping.tip.received',
        {
          senderAddress: 'ak_sender',
          receiverAddress: 'ak_receiver',
          amountAe: '1.5',
          amountAettos: '1500000000000000000',
          txHash: 'th_tip',
          postId: 'post-1_v3',
        },
      );
    });

    it('does not emit when the tip transaction rolls back, and rethrows so the tx is parked', async () => {
      tipRepository.manager.transaction.mockRejectedValue(
        new Error('deadlock'),
      );
      await expect(
        service.processTransaction(tipTx, 'live' as any),
      ).rejects.toThrow('deadlock');
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('does not emit during backfill or reorg replay', async () => {
      await service.processTransaction(tipTx, 'backward' as any);
      await service.processTransaction(tipTx, 'reorg' as any);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('does not emit when nothing was saved (self tip)', async () => {
      (service as any).saveTipFromTransaction.mockResolvedValue(null);
      await service.processTransaction(tipTx, 'live' as any);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    describe('with an encoded TIP_POST payload', () => {
      const encodedTipTx = (recipient: string) =>
        ({
          type: 'SpendTx',
          hash: 'th_tip',
          sender_id: 'ak_sender',
          recipient_id: recipient,
          raw: {
            payload: encode(Buffer.from('TIP_POST:1_v3'), Encoding.Bytearray),
            amount: '2000000000000000000',
          },
        }) as any;
      let postFindOne: jest.Mock;

      beforeEach(() => {
        // Run the real decode and save path against a mocked manager.
        (service as any).validateTransaction.mockRestore();
        (service as any).saveTipFromTransaction.mockRestore();
        postFindOne = jest.fn().mockResolvedValue({
          id: '1_v3',
          sender_address: 'ak_author',
          token_mentions: [],
        });
        const manager = {
          getRepository: jest.fn((entity: any) =>
            entity.name === 'Tip'
              ? {
                  upsert: jest.fn(),
                  findOneOrFail: jest
                    .fn()
                    .mockResolvedValue({ tx_hash: 'th_tip', amount: '2' }),
                }
              : { findOne: postFindOne },
          ),
        };
        tipRepository.manager.transaction.mockImplementation(
          async (handler: any) => handler(manager),
        );
        accountService.ensureAccountExists.mockResolvedValue({});
      });

      it('attaches the post when the tip paid its author', async () => {
        await service.processTransaction(
          encodedTipTx('ak_author'),
          'live' as any,
        );
        expect(postFindOne).toHaveBeenCalledWith({ where: { id: '1_v3' } });
        expect(eventEmitter.emit).toHaveBeenCalledWith(
          'social-tipping.tip.received',
          expect.objectContaining({
            receiverAddress: 'ak_author',
            amountAettos: '2000000000000000000',
            postId: '1_v3',
          }),
        );
      });

      it('treats a tip paid to someone else as a profile tip', async () => {
        await service.processTransaction(
          encodedTipTx('ak_third_party'),
          'live' as any,
        );
        expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
        const [, payload] = eventEmitter.emit.mock.calls[0];
        expect(payload.receiverAddress).toBe('ak_third_party');
        expect(payload).not.toHaveProperty('postId');
      });
    });
  });

  it('emits and recalculates trending only after the tip transaction commits', async () => {
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
    tokensService.queueTrendingScoresForSymbols.mockImplementation(async () => {
      callOrder.push('recalculate');
    });
    eventEmitter.emit.mockImplementation(() => {
      callOrder.push('emit');
    });

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
      'emit',
      'recalculate',
    ]);
    expect(tokensService.queueTrendingScoresForSymbols).toHaveBeenCalledWith([
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
    tokensService.queueTrendingScoresForSymbols.mockRejectedValue(
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
    expect(tokensService.queueTrendingScoresForSymbols).toHaveBeenCalledWith([
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
    expect(tokensService.queueTrendingScoresForSymbols).not.toHaveBeenCalled();
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
      accountService,
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
      accountService,
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

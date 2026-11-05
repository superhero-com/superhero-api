import { ACTIVE_NETWORK } from '@/configs/network';
import { fetchJson } from '@/utils/common';
import { FastPullTokensService } from './fast-pull-tokens.service';

jest.mock('@/utils/common', () => ({
  ...jest.requireActual('@/utils/common'),
  fetchJson: jest.fn(),
}));

describe('FastPullTokensService.pullLatestCreatedTokens', () => {
  const FACTORY = 'ct_factory';
  const createTx = {
    hash: 'th_create',
    micro_time: 1793759698409,
    tx: { function: 'create_community', caller_id: 'ak_creator' },
  };

  let service: FastPullTokensService;
  let tokensService: any;
  let communityFactoryService: any;
  let transactionService: any;
  let syncStateRepository: any;

  beforeEach(() => {
    (fetchJson as jest.Mock)
      .mockReset()
      .mockResolvedValue({ data: [createTx], next: null });
    // Only the creator: a call to anything else, like a token delete, throws.
    tokensService = {
      createTokenFromRawTransaction: jest
        .fn()
        .mockResolvedValue({ sale_address: 'ct_sale' }),
    };
    communityFactoryService = {
      getCurrentFactory: jest.fn().mockResolvedValue({ address: FACTORY }),
    };
    transactionService = { saveTransaction: jest.fn() };
    syncStateRepository = {
      findOne: jest.fn().mockResolvedValue({ tip_height: 1000 }),
    };
    service = new FastPullTokensService(
      tokensService,
      communityFactoryService,
      transactionService,
      syncStateRepository,
      {} as any,
      {} as any,
    );
  });

  it('indexes the last 100 blocks of factory calls without deleting tokens', async () => {
    await service.pullLatestCreatedTokens();

    const url = new URL((fetchJson as jest.Mock).mock.calls[0][0]);
    expect(url.href.startsWith(ACTIVE_NETWORK.middlewareUrl)).toBe(true);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      direction: 'backward',
      limit: '100',
      scope: 'gen:900-1000',
      type: 'contract_call',
      contract: FACTORY,
    });
    expect(tokensService.createTokenFromRawTransaction).toHaveBeenCalledWith(
      createTx,
    );
    expect(transactionService.saveTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ hash: 'th_create', microTime: 1793759698409 }),
      { sale_address: 'ct_sale' },
    );
  });

  it('does nothing before the indexer has a tip', async () => {
    syncStateRepository.findOne.mockResolvedValue(null);

    await service.pullLatestCreatedTokens();

    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('runs again after a failed run', async () => {
    communityFactoryService.getCurrentFactory.mockRejectedValueOnce(
      new Error('node down'),
    );

    await expect(service.pullLatestCreatedTokens()).rejects.toThrow(
      'node down',
    );
    await service.pullLatestCreatedTokens();

    expect(fetchJson).toHaveBeenCalledTimes(1);
  });
});

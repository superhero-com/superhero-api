import BigNumber from 'bignumber.js';
import { BCL_FUNCTIONS } from '@/configs';
import { TokenHolderService } from './token-holder.service';

describe('TokenHolderService', () => {
  let service: TokenHolderService;
  let repository: {
    findOne: jest.Mock;
    update: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let tokenService: {
    update: jest.Mock;
    loadAndSaveTokenHoldersFromMdw: jest.Mock;
  };

  beforeEach(() => {
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(0),
    };

    repository = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => queryBuilder),
    };

    tokenService = {
      update: jest.fn().mockResolvedValue(undefined),
      loadAndSaveTokenHoldersFromMdw: jest.fn().mockResolvedValue(undefined),
    };

    service = new TokenHolderService(repository as any, tokenService as any);
  });

  it('removes a holder from the count when they sell their full balance', async () => {
    repository.findOne.mockResolvedValue({
      id: 'ak_user_ct_token',
      balance: new BigNumber('2000000000000000000'),
    });

    await service.updateTokenHolder(
      {
        address: 'ct_token',
        sale_address: 'ct_sale',
        holders_count: 1,
      } as any,
      {
        function: BCL_FUNCTIONS.sell,
        caller_id: 'ak_user',
        hash: 'th_sell',
        block_height: 10,
      } as any,
      new BigNumber(2),
    );

    expect(repository.update).toHaveBeenCalledTimes(1);
    const updatedHolder = repository.update.mock.calls[0][1];
    expect(updatedHolder.balance.isZero()).toBe(true);
    expect(tokenService.update).toHaveBeenCalledWith(
      expect.objectContaining({ address: 'ct_token' }),
      { holders_count: 0 },
    );
  });

  it('adds a zero-balance account back to the holder count after a buy', async () => {
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(1),
    };
    repository.createQueryBuilder.mockReturnValue(queryBuilder);
    repository.findOne.mockResolvedValue({
      id: 'ak_user_ct_token',
      balance: new BigNumber(0),
    });

    await service.updateTokenHolder(
      {
        address: 'ct_token',
        sale_address: 'ct_sale',
        holders_count: 0,
      } as any,
      {
        function: BCL_FUNCTIONS.buy,
        caller_id: 'ak_user',
        hash: 'th_buy',
        block_height: 11,
      } as any,
      new BigNumber(2),
    );

    expect(tokenService.update).toHaveBeenCalledWith(
      expect.objectContaining({ address: 'ct_token' }),
      { holders_count: 1 },
    );
  });
});

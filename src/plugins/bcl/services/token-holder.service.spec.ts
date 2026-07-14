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
  let balanceIndexer: {
    applyDelta: jest.Mock;
    emitBalanceChanged: jest.Mock;
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

    balanceIndexer = {
      applyDelta: jest.fn().mockResolvedValue(new BigNumber('1')),
      emitBalanceChanged: jest.fn(),
    };

    service = new TokenHolderService(
      repository as any,
      tokenService as any,
      balanceIndexer as any,
    );
  });

  it('standalone (no manager): mirrors the buy delta into token_balance and emits immediately', async () => {
    repository.findOne.mockResolvedValue({
      id: 'ak_user_ct_token',
      balance: new BigNumber('1000000000000000000'),
    });

    const deferred = await service.updateTokenHolder(
      { address: 'ct_token', sale_address: 'ct_sale', holders_count: 1 } as any,
      {
        function: BCL_FUNCTIONS.buy,
        caller_id: 'ak_user',
        hash: 'th_buy2',
        block_height: 12,
      } as any,
      new BigNumber(1),
    );

    // No outer transaction → applyDelta gets no manager and emit fires now.
    expect(balanceIndexer.applyDelta).toHaveBeenCalledWith(
      'ct_token',
      'ak_user',
      expect.any(BigNumber),
      12,
      undefined,
    );
    const [, , appliedDelta] = balanceIndexer.applyDelta.mock.calls[0];
    expect(appliedDelta.isPositive()).toBe(true);
    expect(balanceIndexer.emitBalanceChanged).toHaveBeenCalledWith(
      'ct_token',
      'ak_user',
    );
    // Nothing left for a caller to fire post-commit.
    expect(deferred).toBeNull();
  });

  it('transactional (manager): routes the write through the manager and DEFERS the emit until the returned callback fires', async () => {
    repository.findOne.mockResolvedValue({
      id: 'ak_user_ct_token',
      balance: new BigNumber('1000000000000000000'),
    });
    const manager = { getRepository: jest.fn() } as any;

    const deferred = await service.updateTokenHolder(
      { address: 'ct_token', sale_address: 'ct_sale', holders_count: 1 } as any,
      {
        function: BCL_FUNCTIONS.buy,
        caller_id: 'ak_user',
        hash: 'th_buy3',
        block_height: 14,
      } as any,
      new BigNumber(1),
      manager,
    );

    // The token_balance write must join the outer transaction (manager passed).
    expect(balanceIndexer.applyDelta).toHaveBeenCalledWith(
      'ct_token',
      'ak_user',
      expect.any(BigNumber),
      14,
      manager,
    );
    // Crucially: NOT emitted yet — a rollback after this point must discard it.
    expect(balanceIndexer.emitBalanceChanged).not.toHaveBeenCalled();

    // The caller fires it only after commit.
    expect(typeof deferred).toBe('function');
    deferred!();
    expect(balanceIndexer.emitBalanceChanged).toHaveBeenCalledWith(
      'ct_token',
      'ak_user',
    );
  });

  it('transactional (manager): no balance change → no deferred callback, no emit', async () => {
    balanceIndexer.applyDelta.mockResolvedValue(null);
    repository.findOne.mockResolvedValue({
      id: 'ak_user_ct_token',
      balance: new BigNumber('1000000000000000000'),
    });
    const manager = { getRepository: jest.fn() } as any;

    const deferred = await service.updateTokenHolder(
      { address: 'ct_token', sale_address: 'ct_sale', holders_count: 1 } as any,
      {
        function: BCL_FUNCTIONS.buy,
        caller_id: 'ak_user',
        hash: 'th_buy4',
        block_height: 15,
      } as any,
      new BigNumber(1),
      manager,
    );

    expect(deferred).toBeNull();
    expect(balanceIndexer.emitBalanceChanged).not.toHaveBeenCalled();
  });

  it('mirrors the sell delta as negative and skips the emit when applyDelta reports no change', async () => {
    balanceIndexer.applyDelta.mockResolvedValue(null);
    repository.findOne.mockResolvedValue({
      id: 'ak_user_ct_token',
      balance: new BigNumber('2000000000000000000'),
    });

    await service.updateTokenHolder(
      { address: 'ct_token', sale_address: 'ct_sale', holders_count: 1 } as any,
      {
        function: BCL_FUNCTIONS.sell,
        caller_id: 'ak_user',
        hash: 'th_sell2',
        block_height: 13,
      } as any,
      new BigNumber(1),
    );

    const [, , appliedDelta] = balanceIndexer.applyDelta.mock.calls[0];
    expect(appliedDelta.isNegative()).toBe(true);
    expect(balanceIndexer.emitBalanceChanged).not.toHaveBeenCalled();
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

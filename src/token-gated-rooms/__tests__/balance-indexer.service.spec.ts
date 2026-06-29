import { BigNumber } from 'bignumber.js';
import { BalanceIndexerService } from '../services/balance-indexer.service';
import type { TokenBalance } from '../entities/token-balance.entity';

const TOKEN = 'ct_token';
const HOLDER = 'ak_holder';

/**
 * Unit coverage for the allowlist cache + `applyDelta` clamp logic (Task 03).
 * Repositories + emitter are stubbed; the focus is the negative-clamp guard
 * (mirrors `TokenHolderService.calculateNewBalance`) and the change-detection
 * that drives `tgr.balance.changed`.
 */
describe('BalanceIndexerService', () => {
  const makeService = (opts: {
    tokenRows?: Array<{ address: string }>;
    existingBalance?: TokenBalance | null;
    refreshSec?: number;
  }) => {
    const tokenBalanceStore = {
      value: opts.existingBalance ?? null,
    };
    const tokenRepository = {
      find: jest.fn().mockResolvedValue(opts.tokenRows ?? []),
      findOne: jest.fn(),
    };
    const tokenBalanceRepository = {
      findOne: jest
        .fn()
        .mockImplementation(async () => tokenBalanceStore.value),
      create: jest.fn().mockImplementation((x) => x),
      save: jest.fn().mockImplementation(async (x) => {
        tokenBalanceStore.value = x as TokenBalance;
        return x;
      }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const eventEmitter = { emit: jest.fn() };
    const config = {
      communityTokenRefreshSec: opts.refreshSec ?? 300,
    };
    const service = new BalanceIndexerService(
      tokenRepository as any,
      tokenBalanceRepository as any,
      eventEmitter as any,
      config as any,
    );
    return {
      service,
      tokenRepository,
      tokenBalanceRepository,
      eventEmitter,
      tokenBalanceStore,
    };
  };

  describe('applyDelta', () => {
    it('increments a new holder from zero (to leg)', async () => {
      const { service } = makeService({ existingBalance: null });
      const next = await service.applyDelta(
        TOKEN,
        HOLDER,
        new BigNumber('1000'),
        50,
      );
      expect(next?.toFixed()).toBe('1000');
    });

    it('decrements an existing balance (from leg)', async () => {
      const { service } = makeService({
        existingBalance: {
          token_address: TOKEN,
          holder_address: HOLDER,
          balance: new BigNumber('1000'),
          updated_height: 10,
          last_reconciled_at: null as any,
        },
      });
      const next = await service.applyDelta(
        TOKEN,
        HOLDER,
        new BigNumber('-400'),
        60,
      );
      expect(next?.toFixed()).toBe('600');
    });

    it('clamps at 0 — never persists a negative balance', async () => {
      const { service } = makeService({
        existingBalance: {
          token_address: TOKEN,
          holder_address: HOLDER,
          balance: new BigNumber('100'),
          updated_height: 10,
          last_reconciled_at: null as any,
        },
      });
      const next = await service.applyDelta(
        TOKEN,
        HOLDER,
        new BigNumber('-999999'),
        60,
      );
      expect(next?.toFixed()).toBe('0');
    });

    it('returns null when the balance does not actually change', async () => {
      const { service, tokenBalanceRepository } = makeService({
        existingBalance: {
          token_address: TOKEN,
          holder_address: HOLDER,
          balance: new BigNumber('0'),
          updated_height: 10,
          last_reconciled_at: null as any,
        },
      });
      // already 0, clamp keeps it 0 → no change
      const next = await service.applyDelta(
        TOKEN,
        HOLDER,
        new BigNumber('-5'),
        60,
      );
      expect(next).toBeNull();
      // height was newer → only an updated_height bump, not a balance save
      expect(tokenBalanceRepository.update).toHaveBeenCalled();
    });
  });

  describe('allowlist', () => {
    it('loads community-token addresses from Token where address is set', async () => {
      const { service } = makeService({
        tokenRows: [{ address: 'ct_a' }, { address: 'ct_b' }],
      });
      await service.refreshAllowlist();
      expect(service.isCommunityToken('ct_a')).toBe(true);
      expect(service.isCommunityToken('ct_b')).toBe(true);
      expect(service.isCommunityToken('ct_c')).toBe(false);
    });

    it('addToAllowlist makes a new token indexable immediately', async () => {
      const { service } = makeService({ tokenRows: [] });
      await service.refreshAllowlist();
      expect(service.isCommunityToken('ct_new')).toBe(false);
      service.addToAllowlist('ct_new');
      expect(service.isCommunityToken('ct_new')).toBe(true);
    });

    it('isCommunityToken(undefined/null) is false', async () => {
      const { service } = makeService({ tokenRows: [] });
      await service.refreshAllowlist();
      expect(service.isCommunityToken(undefined)).toBe(false);
      expect(service.isCommunityToken(null)).toBe(false);
    });

    it('onCommunityUpserted adds the token AEX9 address', async () => {
      const { service, tokenRepository } = makeService({ tokenRows: [] });
      await service.refreshAllowlist();
      tokenRepository.findOne.mockResolvedValue({ address: 'ct_upserted' });
      await service.onCommunityUpserted({ saleAddress: 'ct_sale' });
      expect(service.isCommunityToken('ct_upserted')).toBe(true);
    });

    it('onLiveTx refreshes the allowlist on a create_community tx', async () => {
      const { service, tokenRepository } = makeService({ tokenRows: [] });
      await service.refreshAllowlist();
      tokenRepository.find.mockResolvedValue([{ address: 'ct_fresh' }]);
      await service.onLiveTx({
        hash: 'th_x',
        type: 'ContractCallTx',
        function: 'create_community',
      } as any);
      expect(service.isCommunityToken('ct_fresh')).toBe(true);
    });

    it('onLiveTx ignores non-create_community txs', async () => {
      const { service, tokenRepository } = makeService({ tokenRows: [] });
      await service.refreshAllowlist();
      tokenRepository.find.mockClear();
      await service.onLiveTx({
        hash: 'th_y',
        type: 'ContractCallTx',
        function: 'buy',
      } as any);
      expect(tokenRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('emitBalanceChanged', () => {
    it('emits the thin canonical payload', () => {
      const { service, eventEmitter } = makeService({});
      service.emitBalanceChanged(TOKEN, HOLDER);
      expect(eventEmitter.emit).toHaveBeenCalledWith('tgr.balance.changed', {
        tokenAddress: TOKEN,
        holderAddress: HOLDER,
      });
    });
  });
});

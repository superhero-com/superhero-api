import { BigNumber } from 'bignumber.js';
import { fetchJson } from '@/utils/common';
import { Token } from '@/tokens/entities/token.entity';
import { StaleTokenSyncService } from './stale-token-sync.service';

jest.mock('@/utils/common', () => {
  const actual = jest.requireActual('@/utils/common');
  return { ...actual, fetchJson: jest.fn() };
});

const mdw = fetchJson as jest.Mock;

/** One middleware `/v3/transactions` page with a single latest tx. */
const latestTx = (hash: string, block_height: number) => ({
  data: [{ hash, block_height }],
});

const makeToken = (overrides: Partial<Token> = {}): Token =>
  ({
    sale_address: 'ct_sale',
    address: 'ct_token',
    last_tx_hash: 'th_old',
    last_sync_block_height: 1000,
    has_nostr_room: true,
    ...overrides,
  }) as Token;

describe('StaleTokenSyncService', () => {
  let service: StaleTokenSyncService;
  let tokenRepo: any;
  let tokensService: any;
  let balanceIndexer: any;
  let eligibility: any;

  beforeEach(() => {
    mdw.mockReset();
    tokenRepo = {
      createQueryBuilder: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    };
    tokensService = { loadAndSaveTokenHoldersFromMdw: jest.fn() };
    balanceIndexer = {
      setAuthoritativeBalance: jest.fn().mockResolvedValue(null),
    };
    eligibility = { recomputeRoomFromHolders: jest.fn().mockResolvedValue(1) };
    service = new StaleTokenSyncService(
      tokenRepo,
      tokensService,
      balanceIndexer,
      eligibility,
    );
  });

  it('detects a token with a missed tx and heals all three read paths', async () => {
    // Middleware knows a newer sale-contract tx than the token's stored cursor.
    mdw.mockResolvedValue(latestTx('th_new', 1300));
    // The re-sync returns the authoritative holder set including the missed holder.
    tokensService.loadAndSaveTokenHoldersFromMdw.mockResolvedValue({
      aex9Address: 'ct_token',
      holders: [
        {
          id: 'ak_holder_ct_token',
          aex9_address: 'ct_token',
          address: 'ak_holder',
          balance: new BigNumber('167347025000000000000'),
        },
      ],
    });

    const healed = await service.reconcileToken(makeToken());

    expect(healed).toBe(true);
    // 1) holders + account tokens: re-synced from middleware.
    expect(tokensService.loadAndSaveTokenHoldersFromMdw).toHaveBeenCalledWith(
      'ct_sale',
    );
    // 2) room eligibility: balance ledger seeded, then existing recompute driven.
    expect(balanceIndexer.setAuthoritativeBalance).toHaveBeenCalledWith(
      'ct_token',
      'ak_holder',
      expect.any(BigNumber),
      1300,
    );
    expect(eligibility.recomputeRoomFromHolders).toHaveBeenCalledWith(
      'ct_sale',
    );
    // 3) sync cursor advanced so the token stops matching the predicate.
    expect(tokenRepo.update).toHaveBeenCalledWith(
      { sale_address: 'ct_sale' },
      { last_sync_block_height: 1300, last_tx_hash: 'th_new' },
    );
  });

  it('does not sweep a fully-synced token (predicate no-op)', async () => {
    // Middleware's latest tx is exactly the stored one — nothing to heal.
    mdw.mockResolvedValue(latestTx('th_old', 1000));

    const healed = await service.reconcileToken(makeToken());

    expect(healed).toBe(false);
    expect(tokensService.loadAndSaveTokenHoldersFromMdw).not.toHaveBeenCalled();
    expect(balanceIndexer.setAuthoritativeBalance).not.toHaveBeenCalled();
    expect(eligibility.recomputeRoomFromHolders).not.toHaveBeenCalled();
    expect(tokenRepo.update).not.toHaveBeenCalled();
  });

  it('never lowers a stored height (monotonic guard)', async () => {
    // Stored height is already AHEAD of the middleware's latest read (e.g. a lagging
    // mdw replica). A different hash must not drag the cursor backwards.
    mdw.mockResolvedValue(latestTx('th_new', 1500));

    const healed = await service.reconcileToken(
      makeToken({ last_sync_block_height: 2000 }),
    );

    expect(healed).toBe(false);
    expect(tokensService.loadAndSaveTokenHoldersFromMdw).not.toHaveBeenCalled();
    expect(tokenRepo.update).not.toHaveBeenCalled();
  });

  it('does not advance the height when the holder re-sync could not run', async () => {
    // A concurrent sync holds the write lock → loadAndSave returns null. The token
    // stays flagged stale (no height advance) so the next run retries.
    mdw.mockResolvedValue(latestTx('th_new', 1300));
    tokensService.loadAndSaveTokenHoldersFromMdw.mockResolvedValue(null);

    const healed = await service.reconcileToken(makeToken());

    expect(healed).toBe(false);
    expect(balanceIndexer.setAuthoritativeBalance).not.toHaveBeenCalled();
    expect(eligibility.recomputeRoomFromHolders).not.toHaveBeenCalled();
    expect(tokenRepo.update).not.toHaveBeenCalled();
  });

  it('runOnce rotates a bounded batch and counts heals', async () => {
    const rows = [makeToken()];
    const builder: any = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(rows),
    };
    tokenRepo.createQueryBuilder.mockReturnValue(builder);
    mdw.mockResolvedValue(latestTx('th_new', 1300));
    tokensService.loadAndSaveTokenHoldersFromMdw.mockResolvedValue({
      aex9Address: 'ct_token',
      holders: [],
    });

    const result = await service.runOnce();

    expect(result).toEqual({ scanned: 1, healed: 1 });
    // Only community-room tokens are swept.
    expect(builder.where).toHaveBeenCalledWith('t.has_nostr_room = :hasRoom', {
      hasRoom: true,
    });
    // A short batch wraps the rotating cursor back to the start.
    expect(service.getCursor()).toBe('');
  });
});

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Token } from '@/tokens/entities/token.entity';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import { TokensService } from '@/tokens/tokens.service';
import { BCL_FUNCTIONS } from '@/configs';
import { BalanceIndexerService } from '@/token-gated-rooms/services/balance-indexer.service';
import { Encoded } from '@aeternity/aepp-sdk';
import BigNumber from 'bignumber.js';

@Injectable()
export class TokenHolderService {
  private readonly logger = new Logger(TokenHolderService.name);

  constructor(
    @InjectRepository(TokenHolder)
    private tokenHolderRepository: Repository<TokenHolder>,
    private readonly tokenService: TokensService,
    private readonly balanceIndexer: BalanceIndexerService,
  ) {}

  /**
   * Determine if transaction increases token balance (buy or create_community with volume)
   */
  private isBuyTransaction(tx: Tx, volume: BigNumber): boolean {
    return (
      tx.function === BCL_FUNCTIONS.buy ||
      (tx.function === BCL_FUNCTIONS.create_community && volume.gt(0))
    );
  }

  /**
   * Calculate new balance based on transaction type
   */
  private calculateNewBalance(
    currentBalance: BigNumber,
    volume: BigNumber,
    isBuy: boolean,
  ): BigNumber {
    const normalizedBalance = currentBalance.isNegative()
      ? new BigNumber(0)
      : currentBalance;
    const nextBalance = isBuy
      ? normalizedBalance.plus(volume)
      : normalizedBalance.minus(volume);
    return nextBalance.isNegative() ? new BigNumber(0) : nextBalance;
  }

  private async getPositiveHolderCount(
    aex9Address: string,
    repository: Repository<TokenHolder>,
  ): Promise<number> {
    return repository
      .createQueryBuilder('token_holders')
      .where('token_holders.aex9_address = :aex9_address', {
        aex9_address: aex9Address,
      })
      .andWhere('token_holders.balance > 0')
      .getCount();
  }

  /**
   * Update token holders count
   */
  private async updateTokenHoldersCount(
    token: Token,
    newCount: number,
    manager?: EntityManager,
  ): Promise<void> {
    if (manager) {
      await manager.getRepository(Token).update(token.sale_address, {
        holders_count: newCount,
      });
    } else {
      await this.tokenService.update(token, {
        holders_count: newCount,
      });
    }
  }

  /**
   * Update token holder based on transaction
   * Optimized for performance with single query and simplified logic
   *
   * Returns a post-commit callback the caller MUST invoke *after* the
   * surrounding transaction commits (when a transactional `manager` is passed),
   * or `null` when there is nothing to emit. The `tgr.balance.changed` emit is
   * deferred this way so it never fires on a balance the outer transaction then
   * rolls back, and so `EligibilityService` never recomputes off a value that is
   * not yet visible on other connections. In the standalone path (no `manager`,
   * so no outer transaction) the emit fires immediately and `null` is returned.
   */
  async updateTokenHolder(
    token: Token,
    tx: Tx,
    volume: BigNumber,
    manager?: EntityManager,
  ): Promise<(() => void) | null> {
    // Early return if token.address is null (token not yet initialized)
    if (!token.address) {
      return null;
    }

    // Determine transaction type upfront
    const isBuy = this.isBuyTransaction(tx, volume);

    // Set inside the try when a balance change is persisted; returned to the
    // caller to fire AFTER the surrounding transaction commits (see doc above).
    let emitBalanceChanged: (() => void) | null = null;

    try {
      const bigNumberVolume = new BigNumber(volume).multipliedBy(10 ** 18);
      const repository =
        manager?.getRepository(TokenHolder) || this.tokenHolderRepository;

      // Single query to find existing holder
      const tokenHolder = await repository.findOne({
        where: {
          aex9_address: token.address,
          address: tx.caller_id,
        },
      });

      if (tokenHolder) {
        // Update existing holder
        const wasHolder = tokenHolder.balance.gt(0);
        const newBalance = this.calculateNewBalance(
          tokenHolder.balance,
          bigNumberVolume,
          isBuy,
        );
        const isHolder = newBalance.gt(0);

        await repository.update(tokenHolder.id, {
          balance: newBalance,
          last_tx_hash: tx.hash,
          block_number: tx.block_height,
        });

        if (wasHolder !== isHolder || (isHolder && token.holders_count === 0)) {
          const tokenHolderCount = await this.getPositiveHolderCount(
            token.address,
            repository,
          );
          await this.updateTokenHoldersCount(token, tokenHolderCount, manager);
        }
      } else {
        // Create new holder (only for buy transactions)
        if (!isBuy) {
          // Can't create holder for sell transaction
          return null;
        }

        await repository.save({
          id: `${tx.caller_id}_${token.address}`,
          aex9_address: token.address,
          address: tx.caller_id,
          balance: bigNumberVolume,
          last_tx_hash: tx.hash,
          block_number: tx.block_height,
        });

        // Get current holders count only when creating new holder
        const tokenHolderCount = await this.getPositiveHolderCount(
          token.address,
          repository,
        );

        await this.updateTokenHoldersCount(token, tokenHolderCount, manager);
      }

      // Mirror this delta into `token_balance` — the AEX9 indexer's ledger that
      // `EligibilityService` reads for room eligibility (Task 06). Buy/sell calls
      // hit the sale/bonding-curve contract, not the AEX9 token contract itself,
      // so `Aex9TransferSyncService` never sees these txs and `token_balance`
      // would otherwise never reflect buy/sell balance changes. Going through
      // `BalanceIndexerService.applyDelta` (same helper the AEX9 indexer uses)
      // keeps both ledgers consistent, and emitting only when it reports a real
      // change avoids waking `EligibilityService.onBalanceChanged` on a stale or
      // no-op balance. `token.address` is non-null here (early-returned above);
      // the sell-with-no-holder case returned before this point.
      //
      // Pass `manager` so this write joins the SAME transaction as the
      // `token_holders` update above: an outer rollback must revert both
      // ledgers atomically, never leave `token_balance` ahead of real holdings.
      const tokenAddress = token.address;
      const holderAddress = tx.caller_id;
      const delta = isBuy ? bigNumberVolume : bigNumberVolume.negated();
      const changed = await this.balanceIndexer.applyDelta(
        tokenAddress,
        holderAddress,
        delta,
        tx.block_height ?? 0,
        manager,
      );
      if (changed !== null) {
        // Defer the emit past the outer transaction's commit (the caller fires
        // the returned callback). Emitting here — before commit — would let
        // `EligibilityService` recompute off a balance that is not yet visible
        // on its connection, or one a rollback then discards. With no `manager`
        // there is no outer transaction, so emit immediately and return null.
        emitBalanceChanged = () =>
          this.balanceIndexer.emitBalanceChanged(tokenAddress, holderAddress);
        if (!manager) {
          emitBalanceChanged();
          emitBalanceChanged = null;
        }
      }
    } catch (error) {
      this.logger.error('Error updating token holder', error);
      throw error;
    }

    // Background operation - keep outside transaction
    if (!manager) {
      try {
        await this.tokenService.loadAndSaveTokenHoldersFromMdw(
          token.sale_address as Encoded.ContractAddress,
        );
      } catch (error: any) {
        this.logger.error(
          `Error loading and saving token holders from mdw`,
          error,
          error.stack,
        );
      }
    }

    return emitBalanceChanged;
  }
}

import { AccountService } from '@/account/services/account.service';
import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { Token } from '@/tokens/entities/token.entity';
import { BCL_FUNCTIONS } from '@/configs';
import { TransactionData } from './transaction-data.service';
import {
  TRADE_ELIGIBLE_TX_TYPES,
  incrementTradeEligibilityCount,
} from '../utils/trade-eligibility.util';

@Injectable()
export class TransactionPersistenceService {
  private readonly logger = new Logger(TransactionPersistenceService.name);

  constructor(private readonly accountService: AccountService) {}

  /**
   * Cleanup old create_community transactions for the same sale address
   * @param saleAddress - Sale address
   * @param txHash - Current transaction hash (to exclude from deletion)
   * @param manager - Entity manager for transaction
   */
  async cleanupOldTransactions(
    saleAddress: string,
    txHash: string,
    manager: EntityManager,
  ): Promise<string[]> {
    const oldTransactions: Array<{ address: string }> = await manager.query(
      `SELECT DISTINCT address
       FROM transactions
       WHERE sale_address = $1
         AND tx_type = $2
         AND tx_hash != $3`,
      [saleAddress, BCL_FUNCTIONS.create_community, txHash],
    );

    await manager
      .createQueryBuilder()
      .delete()
      .from(Transaction)
      .where('sale_address = :sale_address', {
        sale_address: saleAddress,
      })
      .andWhere('tx_type = :tx_type', {
        tx_type: BCL_FUNCTIONS.create_community,
      })
      .andWhere('tx_hash != :tx_hash', {
        tx_hash: txHash,
      })
      .execute();

    return oldTransactions.map((tx) => tx.address).filter(Boolean);
  }

  /**
   * Save transaction entity
   * @param txData - Transaction data to save
   * @param manager - Entity manager for transaction
   * @returns Saved transaction entity
   */
  async saveTransaction(
    txData: TransactionData,
    manager: EntityManager,
  ): Promise<Transaction> {
    const transactionRepository = manager.getRepository(Transaction);
    const tokenRepository = manager.getRepository(Token);

    // Serializes concurrent saves of the same tx_hash (e.g. overlapping
    // forward/backward sync passes) so the exists-check below can't race
    // with another connection's upsert and double-count the eligibility
    // increment. Xact-scoped: released automatically on commit/rollback of
    // the caller's transaction. Best-effort -- a failure here only reopens
    // the (rare) race window, so it's logged rather than thrown, consistent
    // with how the other non-critical steps in this method are handled.
    try {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        txData.tx_hash,
      ]);
    } catch (error) {
      this.logger.error(
        `Failed to acquire trade-eligibility lock for ${txData.tx_hash}`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    // Checked before the upsert so a re-processed tx (backward sync/reorg
    // replay of an already-persisted hash) is never double-counted below.
    const isNewTransaction = !(await transactionRepository.exists({
      where: { tx_hash: txData.tx_hash },
    }));

    // Use upsert to handle race conditions where transaction might be created concurrently
    // Note: skipUpdateIfNoValuesChanged is removed because it causes PostgreSQL errors
    // when comparing JSON columns (operator does not exist: json = json)
    await transactionRepository.upsert(txData, {
      conflictPaths: ['tx_hash'],
    });

    if (isNewTransaction && TRADE_ELIGIBLE_TX_TYPES.has(txData.tx_type)) {
      try {
        await incrementTradeEligibilityCount(txData.sale_address, manager);
      } catch (error) {
        this.logger.error(
          `Failed to increment trade eligibility count for ${txData.sale_address}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    if (txData.address) {
      try {
        await this.refreshAccountFromTransactions(txData.address, manager);
      } catch (error) {
        this.logger.error(
          `Failed to refresh account totals for ${txData.address}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    // Fetch and return the transaction entity
    const transaction = await transactionRepository.findOne({
      where: { tx_hash: txData.tx_hash },
    });
    if (!transaction) {
      throw new Error(
        `Failed to create or retrieve transaction ${txData.tx_hash}`,
      );
    }

    if (txData.sale_address) {
      try {
        const txCount = await transactionRepository.count({
          where: { sale_address: txData.sale_address },
        });

        await tokenRepository.update(txData.sale_address, {
          tx_count: txCount,
          last_sync_tx_count: txCount,
        });
      } catch (error) {
        this.logger.error(
          `Failed to refresh transaction counters for ${txData.sale_address}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return transaction;
  }

  async refreshAccountFromTransactions(
    address: string,
    manager: EntityManager,
  ): Promise<void> {
    await this.accountService.ensureAccountFromTransactions(address, manager);
  }
}

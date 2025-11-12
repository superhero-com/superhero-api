import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { BCL_FUNCTIONS } from '@/configs';
import { TransactionData } from './transaction-data.service';

@Injectable()
export class TransactionPersistenceService {
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
  ): Promise<void> {
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
    // Use upsert to handle race conditions where transaction might be created concurrently
    // Note: skipUpdateIfNoValuesChanged is removed because it causes PostgreSQL errors
    // when comparing JSON columns (operator does not exist: json = json)
    await transactionRepository.upsert(txData, {
      conflictPaths: ['tx_hash'],
    });
    // Fetch and return the transaction entity
    const transaction = await transactionRepository.findOne({
      where: { tx_hash: txData.tx_hash },
    });
    if (!transaction) {
      throw new Error(`Failed to create or retrieve transaction ${txData.tx_hash}`);
    }
    return transaction;
  }
}


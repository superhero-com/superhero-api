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
    return transactionRepository.save(txData);
  }
}


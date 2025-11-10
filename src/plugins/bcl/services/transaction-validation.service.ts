import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { BCL_FUNCTIONS } from '@/configs';

@Injectable()
export class TransactionValidationService {
  private readonly logger = new Logger(TransactionValidationService.name);

  constructor(
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
  ) {}

  /**
   * Determine sale address from transaction
   * @param tx - Transaction entity
   * @returns Sale address or null if invalid
   */
  determineSaleAddress(tx: Tx): string | null {
    if (tx.function === BCL_FUNCTIONS.create_community) {
      if (!tx.raw?.return?.value?.length) {
        return null;
      }
      return tx.raw.return.value[1].value;
    }
    return tx.contract_id || null;
  }

  /**
   * Check if transaction already exists in database
   * @param txHash - Transaction hash
   * @returns True if transaction exists
   */
  async transactionExists(txHash: string): Promise<boolean> {
    const exists = await this.transactionRepository
      .createQueryBuilder('token_transactions')
      .where('token_transactions.tx_hash = :tx_hash', {
        tx_hash: txHash,
      })
      .getOne();

    return !!exists;
  }

  /**
   * Validate transaction and extract sale address
   * @param tx - Transaction entity
   * @returns Validation result with sale address
   */
  async validateTransaction(tx: Tx): Promise<{
    isValid: boolean;
    saleAddress: string | null;
  }> {
    if (!Object.values(BCL_FUNCTIONS).includes(tx.function)) {
      return { isValid: false, saleAddress: null };
    }
    // Check if transaction already exists
    const exists = await this.transactionExists(tx.hash);
    if (exists) {
      return { isValid: false, saleAddress: null };
    }

    // Determine sale address
    const saleAddress = this.determineSaleAddress(tx);
    if (!saleAddress) {
      return { isValid: false, saleAddress: null };
    }

    return { isValid: true, saleAddress };
  }
}


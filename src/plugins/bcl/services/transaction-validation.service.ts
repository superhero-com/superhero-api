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

  private async findExistingTransaction(
    txHash: string,
  ): Promise<Transaction | null> {
    return this.transactionRepository
      .createQueryBuilder('token_transactions')
      .where('token_transactions.tx_hash = :tx_hash', {
        tx_hash: txHash,
      })
      .getOne();
  }

  private isBrokenTradeTransaction(transaction: Transaction): boolean {
    if (
      !transaction ||
      ![BCL_FUNCTIONS.buy, BCL_FUNCTIONS.sell].includes(transaction.tx_type)
    ) {
      return false;
    }

    const hasZeroVolume =
      transaction.volume == null ||
      (typeof transaction.volume?.isZero === 'function'
        ? transaction.volume.isZero()
        : `${transaction.volume}` === '0');

    const amountAe = transaction.amount?.ae?.toString();
    const unitPriceAe = transaction.unit_price?.ae?.toString();
    const previousBuyPriceAe =
      transaction.previous_buy_price?.ae?.toString();
    const buyPriceAe = transaction.buy_price?.ae?.toString();
    const marketCapAe = transaction.market_cap?.ae?.toString();

    const hasInvalidPriceData = [
      unitPriceAe,
      previousBuyPriceAe,
      buyPriceAe,
      marketCapAe,
    ].some((value) => value === 'NaN');

    return !transaction.verified && (
      hasZeroVolume ||
      amountAe === '0' ||
      hasInvalidPriceData
    );
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

    // Allow block validation to repair previously persisted zero/NaN trade rows.
    const existingTransaction = await this.findExistingTransaction(tx.hash);
    if (
      existingTransaction &&
      !this.isBrokenTradeTransaction(existingTransaction)
    ) {
      return { isValid: false, saleAddress: null };
    }

    if (existingTransaction) {
      this.logger.warn(
        `Reprocessing broken transaction ${tx.hash} to repair derived trade data`,
      );
    }

    // Determine sale address
    const saleAddress = this.determineSaleAddress(tx);
    if (!saleAddress) {
      return { isValid: false, saleAddress: null };
    }

    return { isValid: true, saleAddress };
  }
}

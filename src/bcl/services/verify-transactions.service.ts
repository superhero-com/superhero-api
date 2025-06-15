import { ACTIVE_NETWORK } from '@/configs/network';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { TransactionService } from '@/transactions/services/transaction.service';
import { fetchJson } from '@/utils/common';
import { ITransaction } from '@/utils/types';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { LessThan, Repository } from 'typeorm';
import { SyncBlocksService } from './sync-blocks.service';

@Injectable()
export class VerifyTransactionsService {
  verifyingTransactions = false;
  private readonly logger = new Logger(VerifyTransactionsService.name);

  constructor(
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,

    private readonly transactionService: TransactionService,
    private readonly syncBlocksService: SyncBlocksService,
  ) {
    //
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async fixFailedTransactions() {
    if (this.verifyingTransactions) {
      return;
    }
    this.verifyingTransactions = true;
    const transactions = await this.transactionRepository.find({
      where: {
        verified: false,
        block_height: LessThan(this.syncBlocksService.currentBlockNumber - 100),
      },
      order: {
        created_at: 'ASC',
      },
      take: 100,
    });
    if (transactions.length) {
      for (const transaction of transactions) {
        await this.verifyTransaction(transaction);
      }
      // wait 3 seconds before the next call
      await new Promise((resolve) => setTimeout(resolve, 3000));
      this.fixFailedTransactions(); // recursive call, until all transactions are verified
    }
    this.verifyingTransactions = false;
  }

  private async verifyTransaction(transaction: Transaction) {
    const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions/${transaction.tx_hash}`;
    try {
      const txData: ITransaction = await fetchJson(url).then((res) =>
        camelcaseKeysDeep(res),
      );
      if (txData?.tx?.returnType === 'revert') {
        await this.transactionRepository.delete(transaction.tx_hash);
        return;
      }
      if (
        transaction.block_height !== txData.blockHeight ||
        transaction.tx_type !== txData.tx.function ||
        transaction.address !== txData.tx.callerId
      ) {
        await this.transactionRepository.delete(transaction.tx_hash);
        await this.transactionService.saveTransaction(txData);
        return;
      }

      await this.transactionRepository.update(transaction.tx_hash, {
        verified: true,
      });
    } catch (error: any) {
      this.logger.error(
        `VerifyTransactionsService: ${transaction.tx_hash} - ${error.message}`,
        error.stack,
      );
      await this.transactionRepository.delete(transaction.tx_hash);
    }
  }
}

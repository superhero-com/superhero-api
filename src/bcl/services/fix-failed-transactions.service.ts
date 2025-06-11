import { ACTIVE_NETWORK } from '@/configs/network';
import { TransactionService } from '@/transactions/services/transaction.service';
import { fetchJson } from '@/utils/common';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { LessThan, Repository } from 'typeorm';
import { FailedTransaction } from '../entities/failed-transaction.entity';

@Injectable()
export class FixFailedTransactionsService {
  private readonly logger = new Logger(FixFailedTransactionsService.name);

  constructor(
    @InjectRepository(FailedTransaction)
    private failedTransactionsRepository: Repository<FailedTransaction>,

    private readonly transactionService: TransactionService,
  ) {
    this.fixFailedTransactions();
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async fixFailedTransactions() {
    const failedTransactions = await this.failedTransactionsRepository.find({
      where: {
        retries: LessThan(10),
      },
    });
    for (const failedTransaction of failedTransactions) {
      await this.fixFailedTransaction(failedTransaction);
    }
  }

  async fixFailedTransaction(failedTransaction: FailedTransaction) {
    const { hash, retries } = failedTransaction;
    const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions/${hash}`;
    try {
      const transaction = await fetchJson(url).then((res) =>
        camelcaseKeysDeep(res),
      );
      // TODO: enable this
      if (transaction?.tx?.returnType === 'revert') {
        await this.failedTransactionsRepository.delete(failedTransaction.hash);
        return;
      }
      await this.transactionService.saveTransaction(transaction);
      await this.failedTransactionsRepository.delete(failedTransaction.hash);
      this.logger.log(`FixFailedTransactionsService: ${hash} - success`);
      // TODO: should dispatch re-sync this token trasactions & holder if transaction.tx.function === 'create_community
    } catch (error: any) {
      this.logger.error(
        `FixFailedTransactionsService: ${hash} - ${error.message}`,
        error.stack,
      );
      await this.failedTransactionsRepository.update(failedTransaction.hash, {
        retries: retries + 1,
      });
    }
  }
}

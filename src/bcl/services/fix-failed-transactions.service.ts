import { TX_FUNCTIONS } from '@/configs';
import { ACTIVE_NETWORK } from '@/configs/network';
import { TransactionService } from '@/transactions/services/transaction.service';
import { fetchJson } from '@/utils/common';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { Repository } from 'typeorm';
import { FailedTransaction } from '../entities/failed-transaction.entity';
import { SyncTransactionsService } from './sync-transactions.service';

@Injectable()
export class FixFailedTransactionsService {
  fixingFailedTransactions = false;
  private readonly logger = new Logger(FixFailedTransactionsService.name);

  constructor(
    @InjectRepository(FailedTransaction)
    private failedTransactionsRepository: Repository<FailedTransaction>,

    private readonly transactionService: TransactionService,
    private readonly syncTransactionsService: SyncTransactionsService,
  ) {
    //
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async fixFailedTransactions() {
    if (this.fixingFailedTransactions) {
      return;
    }
    this.fixingFailedTransactions = true;
    const failedTransactions = await this.failedTransactionsRepository.find({
      where: {},
    });
    for (const failedTransaction of failedTransactions) {
      await this.fixFailedTransaction(failedTransaction);
    }
    this.fixingFailedTransactions = false;
  }

  async fixFailedTransaction(failedTransaction: FailedTransaction) {
    const { hash, retries } = failedTransaction;
    const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions/${hash}`;
    try {
      const transaction = await fetchJson(url).then((res) =>
        camelcaseKeysDeep(res),
      );
      if (transaction?.tx?.returnType === 'revert') {
        await this.failedTransactionsRepository.delete(failedTransaction.hash);
        return;
      }
      if (failedTransaction?.retries > 10) {
        return;
      }
      await this.transactionService.saveTransaction(transaction);
      await this.failedTransactionsRepository.delete(failedTransaction.hash);
      this.logger.log(`FixFailedTransactionsService: ${hash} - success`);
      // at this point we can re-sync the community transactions
      if (transaction?.tx?.function === TX_FUNCTIONS.create_community) {
        await this.syncCommunityTransactions(transaction.tx.contractId);
      }
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

  async syncCommunityTransactions(contractId: string) {
    this.logger.log('syncCommunityTransactions', contractId);
    const query: Record<string, string | number> = {
      direction: 'forward',
      limit: 100,
      contract: contractId,
      type: 'contract_call',
    };
    const queryString = Object.keys(query)
      .map((key) => key + '=' + query[key])
      .join('&');
    const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions?${queryString}`;
    await this.syncTransactionsService.fetchAndSyncTransactions(url);
  }
}

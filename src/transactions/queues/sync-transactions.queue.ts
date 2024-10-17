import { Encoded } from '@aeternity/aepp-sdk';
import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { fetchJson } from 'src/ae/utils/common';
import { ACTIVE_NETWORK } from 'src/ae/utils/networks';
import { ITransaction } from 'src/ae/utils/types';
import { TransactionService } from '../services/transaction.service';
import { SYNC_TRANSACTIONS_QUEUE } from './constants';

export interface ISyncTransactionsQueue {
  saleAddress: Encoded.ContractAddress;
}

@Processor(SYNC_TRANSACTIONS_QUEUE)
export class SyncTransactionsQueue {
  private readonly logger = new Logger(SyncTransactionsQueue.name);
  constructor(private transactionService: TransactionService) {
    //
  }

  /**
   * @param job
   */
  @Process()
  async process(job: Job<ISyncTransactionsQueue>) {
    this.logger.log(`SyncTransactionsQueue->started:${job.data.saleAddress}`);
    try {
      await this.pullTokenHistoryData(job);
      this.logger.debug(
        `SyncTransactionsQueue->completed:${job.data.saleAddress}`,
      );
    } catch (error) {
      this.logger.error(`SyncTransactionsQueue->error`, error);
    }
  }

  async pullTokenHistoryData(job: Job<ISyncTransactionsQueue>) {
    this.logger.debug(
      `SyncTransactionsQueue->pullTokenHistoryData:${job.data.saleAddress}`,
    );
    const query: Record<string, string | number> = {
      direction: 'forward',
      limit: 100,
      type: 'contract_call',
      contract: job.data.saleAddress,
    };

    const queryString = Object.keys(query)
      .map((key) => key + '=' + query[key])
      .join('&');

    const url = `${ACTIVE_NETWORK.middlewareUrl}/v2/txs?${queryString}`;
    await this.fetchAndSaveTransactions(job, url);
  }

  async fetchAndSaveTransactions(
    job: Job<ISyncTransactionsQueue>,
    url: string,
  ) {
    this.logger.debug(
      `SyncTransactionsQueue->fetchAndSaveTransactions: ${url}`,
    );
    const response = await fetchJson(url);

    await Promise.all(
      response.data
        .map((item: ITransaction) => camelcaseKeysDeep(item))
        .map((item: ITransaction) =>
          this.transactionService.saveTransaction(item),
        ),
    );

    if (response.next) {
      return this.fetchAndSaveTransactions(
        job,
        `${ACTIVE_NETWORK.middlewareUrl}${response.next}`,
      );
    }

    return null;
  }
}

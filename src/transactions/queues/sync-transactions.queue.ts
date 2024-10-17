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
import { TokensService } from 'src/tokens/tokens.service';
import { Token } from 'src/tokens/entities/token.entity';

export interface ISyncTransactionsQueue {
  saleAddress: Encoded.ContractAddress;
}

@Processor(SYNC_TRANSACTIONS_QUEUE)
export class SyncTransactionsQueue {
  private readonly logger = new Logger(SyncTransactionsQueue.name);
  constructor(
    private transactionService: TransactionService,
    private tokenService: TokensService,
  ) {
    //
  }

  /**
   * @param job
   */
  @Process()
  async process(job: Job<ISyncTransactionsQueue>) {
    this.logger.log(`SyncTransactionsQueue->started:${job.data.saleAddress}`);
    try {
      const token = await this.tokenService.getToken(job.data.saleAddress);
      await this.pullTokenHistoryData(token);
      this.logger.debug(
        `SyncTransactionsQueue->completed:${job.data.saleAddress}`,
      );
    } catch (error) {
      this.logger.error(`SyncTransactionsQueue->error`, error);
    }
  }

  async pullTokenHistoryData(token: Token) {
    this.logger.debug(
      `SyncTransactionsQueue->pullTokenHistoryData:${token.address}`,
    );
    const query: Record<string, string | number> = {
      direction: 'forward',
      limit: 100,
      type: 'contract_call',
      contract: token.sale_address,
    };

    const queryString = Object.keys(query)
      .map((key) => key + '=' + query[key])
      .join('&');

    const url = `${ACTIVE_NETWORK.middlewareUrl}/v2/txs?${queryString}`;
    await this.fetchAndSaveTransactions(token, url);
  }

  async fetchAndSaveTransactions(token: Token, url: string) {
    this.logger.debug(
      `SyncTransactionsQueue->fetchAndSaveTransactions: ${url}`,
    );
    const response = await fetchJson(url);

    await Promise.all(
      response.data
        .map((item: ITransaction) => camelcaseKeysDeep(item))
        .map((item: ITransaction) =>
          this.transactionService.saveTransaction(item, token),
        ),
    );

    if (response.next) {
      return this.fetchAndSaveTransactions(
        token,
        `${ACTIVE_NETWORK.middlewareUrl}${response.next}`,
      );
    }

    return null;
  }
}

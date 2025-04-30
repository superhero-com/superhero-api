import { Encoded } from '@aeternity/aepp-sdk';
import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { fetchJson } from '@/utils/common';
import { ITransaction } from '@/utils/types';
import { ACTIVE_NETWORK } from '@/configs';
import { Token } from '@/tokens/entities/token.entity';
import { TokensService } from '@/tokens/tokens.service';
import { TransactionService } from '../services/transaction.service';
import { SYNC_TRANSACTIONS_QUEUE } from './constants';

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
      const txCount = await fetchJson(
        `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions/count?id=${token.sale_address}`,
      );
      if (txCount !== token.last_sync_tx_count) {
        await this.pullTokenHistoryData(token);
      }
      const localTxCount =
        await this.transactionService.getTokenTransactionsCount(token);
      await this.tokenService.update(token, {
        last_sync_tx_count: txCount,
        tx_count: localTxCount,
      });
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

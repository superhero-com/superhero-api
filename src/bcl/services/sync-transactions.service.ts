import { AeSdkService } from '@/ae/ae-sdk.service';
import { WebSocketService } from '@/ae/websocket.service';
import { ACTIVE_NETWORK, TX_FUNCTIONS } from '@/configs';
import { TransactionService } from '@/transactions/services/transaction.service';
import { fetchJson } from '@/utils/common';
import { ITransaction } from '@/utils/types';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { Repository } from 'typeorm';
import { FailedTransaction } from '../entities/failed-transaction.entity';

@Injectable()
export class SyncTransactionsService {
  private readonly logger = new Logger(SyncTransactionsService.name);

  constructor(
    private websocketService: WebSocketService,
    private readonly aeSdkService: AeSdkService,
    private readonly transactionService: TransactionService,

    @InjectRepository(FailedTransaction)
    private failedTransactionsRepository: Repository<FailedTransaction>,
  ) {
    this.setupLiveSync();
  }

  setupLiveSync() {
    let syncedTransactions = [];

    this.websocketService.subscribeForTransactionsUpdates(
      (transaction: ITransaction) => {
        if (Object.keys(TX_FUNCTIONS).includes(transaction.tx.function)) {
          // Prevent duplicate transactions
          if (!syncedTransactions.includes(transaction.hash)) {
            syncedTransactions.push(transaction.hash);
            this.transactionService.saveTransaction(transaction, null, true);
          }
        }
        // Reset synced transactions after 100 transactions
        if (syncedTransactions.length > 100) {
          syncedTransactions = [];
        }
      },
    );
  }

  latestBlockNumber;
  totalTicks = 0;
  @Cron(CronExpression.EVERY_30_SECONDS)
  async syncTransactions() {
    this.logger.log(`syncTransactions::: ${this.latestBlockNumber}`);

    try {
      const currentGeneration = (
        await this.aeSdkService.sdk.getCurrentGeneration()
      ).keyBlock.height;

      this.logger.log('currentGeneration', currentGeneration);
      if (currentGeneration <= this.latestBlockNumber) {
        this.totalTicks++;
        if (this.totalTicks > 3) {
          this.syncTransactions();
          this.totalTicks = 0;
        }
        this.logger.log('latestBlockNumber is not updated');
        return;
      }
      this.latestBlockNumber = currentGeneration;
      this.logger.log('latestBlockNumber', this.latestBlockNumber);
      const fromBlockNumber = this.latestBlockNumber - 5;
      for (let i = fromBlockNumber; i <= this.latestBlockNumber; i++) {
        await this.syncBlockTransactions(i);
      }
    } catch (error: any) {
      this.logger.error(
        `SyncTransactionsService->Failed to sync transactions`,
        error.stack,
      );
    }
  }

  async syncBlockTransactions(blockNumber: number): Promise<string[]> {
    this.logger.log('syncBlockTransactions', blockNumber);
    const query: Record<string, string | number> = {
      direction: 'forward',
      limit: 100,
      scope: `gen:${blockNumber}`,
      type: 'contract_call',
    };
    const queryString = Object.keys(query)
      .map((key) => key + '=' + query[key])
      .join('&');
    const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions?${queryString}`;
    const transactionsHashes = await this.fetchAndSyncTransactions(url);
    this.logger.log(
      `syncBlockTransactions->transactionsHashes:`,
      transactionsHashes,
    );
    if (transactionsHashes.length > 0) {
      await this.transactionService.deleteNonValidTransactionsInBlock(
        blockNumber,
        transactionsHashes,
      );
    }
    return transactionsHashes;
  }

  async fetchAndSyncTransactions(url: string, validated_hashes = []) {
    this.logger.debug(
      `ValidateTokenTransactionsQueue->fetchAndValidateTransactions: ${url}`,
    );
    const response = await fetchJson(url);

    const transactions = response.data
      ?.filter(
        (item: ITransaction) =>
          !validated_hashes.includes(item.hash) &&
          Object.values(TX_FUNCTIONS).includes(item.tx.function),
      )
      .map((item: ITransaction) => camelcaseKeysDeep(item));

    try {
      for (const transaction of transactions) {
        validated_hashes.push(transaction.hash);
        try {
          await this.transactionService.saveTransaction(transaction);
        } catch (error: any) {
          this.logger.error(
            `Failed to save transaction ${transaction.hash}`,
            error.stack,
          );
          await this.failedTransactionsRepository.save({
            hash: transaction.hash,
            error: error.message,
            error_trace: error.stack,
          });
        }
      }
    } catch (error: any) {
      this.logger.debug('transactions', transactions);
      this.logger.error(
        `Failed to fetch and sync transactions ${url}`,
        error.stack,
      );
    }

    if (response.next) {
      return this.fetchAndSyncTransactions(
        `${ACTIVE_NETWORK.middlewareUrl}${response.next}`,
        validated_hashes,
      );
    }

    return validated_hashes;
  }
}

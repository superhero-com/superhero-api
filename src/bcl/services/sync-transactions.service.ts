import { WebSocketService } from '@/ae/websocket.service';
import { ACTIVE_NETWORK, TX_FUNCTIONS } from '@/configs';
import { TransactionService } from '@/transactions/services/transaction.service';
import { fetchJson } from '@/utils/common';
import { ITransaction } from '@/utils/types';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { Repository } from 'typeorm';
import { FailedTransaction } from '../entities/failed-transaction.entity';

@Injectable()
export class SyncTransactionsService {
  private readonly logger = new Logger(SyncTransactionsService.name);

  constructor(
    private websocketService: WebSocketService,
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
        if (Object.values(TX_FUNCTIONS).includes(transaction.tx.function)) {
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

  async fetchAndSyncTransactions(
    url: string,
    validated_hashes = [],
    callers = [],
  ) {
    this.logger.debug(
      `SyncTransactionsService->fetchAndSyncTransactions: ${url}`,
    );
    const response = await fetchJson(url);

    const items = response.data.filter(
      (item) =>
        !validated_hashes.includes(item.hash) &&
        item?.tx?.return_type !== 'revert',
    );

    for (const item of items) {
      if (
        item?.tx?.caller_id &&
        !callers.includes(item?.tx?.caller_id) &&
        item?.tx?.type !== 'SpendTx'
      ) {
        callers.push(item?.tx?.caller_id);
      }
    }

    const transactions = items
      ?.filter(
        (item) =>
          !validated_hashes.includes(item.hash) &&
          Object.values(TX_FUNCTIONS).includes(item.tx.function) &&
          item?.tx?.return_type !== 'revert',
      )
      .map((item: ITransaction) => camelcaseKeysDeep(item));

    try {
      for (const transaction of transactions) {
        try {
          const result =
            await this.transactionService.saveTransaction(transaction);
          if (result?.id) {
            validated_hashes.push(transaction.hash);
          }
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
        callers,
      );
    }

    return {
      validated_hashes,
      callers,
    };
  }
}

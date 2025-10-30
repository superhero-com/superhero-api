import { ACTIVE_NETWORK, TX_FUNCTIONS } from '@/configs';
import { TransactionService } from '@/plugins/bcl/services/transaction.service';
import { fetchJson } from '@/utils/common';
import { ITransaction } from '@/utils/types';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { Repository } from 'typeorm';
import { FailedTransaction } from '../entities/failed-transaction.entity';
import { DexSyncService } from '@/plugins/dex/services/dex-sync.service';
import { PostService } from '@/plugins/social/services/post.service';
import { TipService } from '@/plugins/tipping/services/tips.service';

@Injectable()
export class SyncTransactionsService {
  private readonly logger = new Logger(SyncTransactionsService.name);

  constructor(
    private readonly transactionService: TransactionService,
    private readonly dexSyncService: DexSyncService,
    private readonly postService: PostService,
    private readonly tipService: TipService,

    @InjectRepository(FailedTransaction)
    private failedTransactionsRepository: Repository<FailedTransaction>,
  ) {
    //
  }

  async handleLiveTransaction(transaction: ITransaction) {
    if (Object.values(TX_FUNCTIONS).includes(transaction.tx.function)) {
      this.transactionService.saveTransaction(transaction, null, true);
    }
  }

  async fetchAndSyncTransactions(
    url: string,
    validated_hashes = [],
    callers = [],
  ) {
    this.logger.debug(
      `SyncTransactionsService->fetchAndSyncTransactions: ${url}`,
    );
    try {
      const response = await fetchJson(url, undefined, true); //

      const items =
        response?.data?.filter(
          (item) =>
            !validated_hashes.includes(item.hash) &&
            item?.tx?.return_type !== 'revert',
        ) || [];

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
            // each transaction should be passed through
            // (BCL, Social, DEX)
            const [dex, social, bcl, tip] = await Promise.all([
              this.dexSyncService.saveTransaction(transaction),
              this.postService.saveTransaction(transaction),
              this.transactionService.saveTransaction(transaction),
              this.tipService.saveTransaction(transaction),
            ]);
            if (dex || social || bcl || tip) {
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
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch and sync transactions ${url}`,
        error.stack,
      );
    }

    return {
      validated_hashes,
      callers,
    };
  }
}

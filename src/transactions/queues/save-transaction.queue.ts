import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { ITransaction } from 'src/ae/utils/types';

import { TokensService } from 'src/tokens/tokens.service';
import { TransactionService } from '../services/transaction.service';
import { SAVE_TRANSACTION_QUEUE } from './constants';

export interface ISaveTransactionQueue {
  transaction: ITransaction;
  shouldBroadcast: boolean;
}

@Processor(SAVE_TRANSACTION_QUEUE)
export class SaveTransactionQueue {
  private readonly logger = new Logger(SaveTransactionQueue.name);

  constructor(
    private tokenService: TokensService,
    private transactionService: TransactionService,
  ) {
    //
  }

  /**
   * @param job
   */
  @Process()
  async process(job: Job<ISaveTransactionQueue>) {
    this.logger.log(
      `SaveTransactionQueue->started:${job.data.transaction.tx.contractId}:${job.data.transaction.hash}`,
    );
    try {
      const transaction = await this.transactionService.saveTransaction(
        job.data.transaction,
      );
      if (job.data.shouldBroadcast) {
        await this.tokenService.syncTokenPrice(transaction.token);
      }

      this.logger.debug(
        `SaveTransactionQueue->completed:${job.data.transaction.tx.contractId}:${job.data.transaction.hash}`,
      );
    } catch (error) {
      this.logger.error(`SaveTransactionQueue->error`, error);
    }
  }
}

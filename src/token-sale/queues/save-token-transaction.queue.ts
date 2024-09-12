import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { ITransaction } from 'src/ae/utils/types';
import { TransactionService } from '../services';
import {
  PULL_TOKEN_PRICE_QUEUE,
  SAVE_TOKEN_TRANSACTION_QUEUE,
} from './constants';

export interface ISaveTokenTransactionQueue {
  transaction: ITransaction;
}

@Processor(SAVE_TOKEN_TRANSACTION_QUEUE)
export class SaveTokenTransactionQueue {
  private readonly logger = new Logger(SaveTokenTransactionQueue.name);

  constructor(
    private transactionService: TransactionService,

    @InjectQueue(PULL_TOKEN_PRICE_QUEUE)
    private readonly pullTokenPriceQueue: Queue,
  ) {}

  /**
   * @param job
   */
  @Process()
  async process(job: Job<ISaveTokenTransactionQueue>) {
    this.logger.log(
      `SaveTokenTransactionQueue->started:${job.data.transaction.tx.contractId}:${job.data.transaction.hash}`,
    );
    try {
      await this.transactionService.saveTransaction(job.data.transaction);

      this.pullTokenPriceQueue.add({
        saleAddress: job.data.transaction.tx.contractId,
        volume: this.transactionService.calculateTxVolume(job.data.transaction),
      });

      this.logger.debug(
        `SaveTokenTransactionQueue->completed:${job.data.transaction.tx.contractId}:${job.data.transaction.hash}`,
      );
    } catch (error) {
      this.logger.error(`SaveTokenTransactionQueue->error`, error);
    }
  }
}

import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, Queue } from 'bull';
import { Repository } from 'typeorm';
import { Transaction } from '../entities/transaction.entity';
import {
  VALIDATE_TOKEN_TRANSACTIONS_QUEUE,
  VALIDATE_TRANSACTIONS_QUEUE,
} from './constants';

export interface IValidateTransactionsQueue {
  from: number; // Block height
  to: number;
}

@Processor(VALIDATE_TRANSACTIONS_QUEUE)
export class ValidateTransactionsQueue {
  private readonly logger = new Logger(ValidateTransactionsQueue.name);
  constructor(
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,

    @InjectQueue(VALIDATE_TOKEN_TRANSACTIONS_QUEUE)
    private readonly validateTokenTransactionsQueue: Queue,
  ) {
    //
  }

  /**
   * Processes a job to validate transactions within a specified block height range.
   *
   * @param job - The job containing the data for validation, including the block height range.
   *
   * The function performs the following steps:
   * 1. Logs the start of the validation process with the specified block height range.
   * 2. Queries the transaction repository to find distinct token IDs of transactions
   *    that fall within the specified block height range and are not verified.
   * 3. For each token ID found, adds a new job to the validateTokenTransactionsQueue
   *    to validate transactions for that specific token.
   * 4. Logs any errors encountered during the process.
   *
   * @throws Will log an error if the query or job addition fails.
   */
  @Process()
  async process(job: Job<IValidateTransactionsQueue>) {
    this.logger.log(
      `ValidateTransactionsQueue->started:from:${job.data.from} - to:${job.data.to}`,
    );
    try {
      const tokens = await this.transactionRepository
        .createQueryBuilder('transactions')
        .where('transactions.block_height >= :from', { from: job.data.from })
        .andWhere('transactions.block_height <= :to', { to: job.data.to })
        .andWhere('transactions.verified = false')
        .select('transactions.tokenId')
        .distinct(true)
        .getRawMany()
        .then((items) => items.map((item) => item.tokenId));

      tokens.forEach((tokenId) => {
        void this.validateTokenTransactionsQueue.add({
          from: job.data.from,
          to: job.data.to,
          tokenId,
        });
      });
    } catch (error) {
      this.logger.error(`ValidateTransactionsQueue->error`, error);
    }
  }
}

import { Encoded } from '@aeternity/aepp-sdk';
import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { ITransaction } from 'src/ae/utils/types';
import { PriceHistoryService } from '../services';
import { PULL_TOKEN_PRICE_QUEUE } from './constants';

export interface IPullTokenPriceQueue {
  saleAddress: Encoded.ContractAddress;
  transaction?: ITransaction;
  live?: boolean;
}

@Processor(PULL_TOKEN_PRICE_QUEUE)
export class PullTokenPriceQueue {
  private readonly logger = new Logger(PullTokenPriceQueue.name);

  constructor(private priceHistoryService: PriceHistoryService) {
    //
  }

  @Process()
  async process(job: Job<IPullTokenPriceQueue>) {
    this.logger.log(`PullTokenPriceQueue->started:${job.data.saleAddress}`);
    try {
      await this.priceHistoryService.savePriceHistoryFromTransaction(
        job.data.saleAddress,
        job.data.transaction,
        job.data.live,
      );
      this.logger.debug(
        `PullTokenPriceQueue->completed:${job.data.saleAddress}`,
      );
    } catch (error) {
      this.logger.error(`PullTokenPriceQueue->error`, error);
    }
  }
}

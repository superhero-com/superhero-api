import { Encoded } from '@aeternity/aepp-sdk';
import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { TokensService } from '../services/tokens.service';
import { SYNC_TOKEN_HOLDERS_QUEUE } from './constants';

export interface ISyncTokenHoldersQueue {
  saleAddress: Encoded.ContractAddress;
}

@Processor(SYNC_TOKEN_HOLDERS_QUEUE)
export class SyncTokenHoldersQueue {
  private readonly logger = new Logger(SyncTokenHoldersQueue.name);

  constructor(private tokenService: TokensService) {
    //
  }

  /**
   * @param job
   */
  @Process({
    concurrency: 10,
  })
  async process(job: Job<ISyncTokenHoldersQueue>) {
    this.logger.log(`SyncTokenHoldersQueue->started:${job.data.saleAddress}`);
    try {
      await this.tokenService.loadAndSaveTokenHoldersFromMdw(
        job.data.saleAddress,
      );
      this.logger.debug(
        `SyncTokenHoldersQueue->completed:${job.data.saleAddress}`,
      );
    } catch (error: any) {
      this.logger.error(`SyncTokenHoldersQueue->error`, error);
      this.logger.error(`SyncTokenHoldersQueue->error:stack::`, error.stack);
    }
  }
}

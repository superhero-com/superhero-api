import { Encoded } from '@aeternity/aepp-sdk';
import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { TokensService } from '../tokens.service';
import { SYNC_TOKEN_HOLDERS_QUEUE } from './constants';

export interface ISyncTokenHoldersQueue {
  saleAddress: Encoded.ContractAddress;
}

@Processor(SYNC_TOKEN_HOLDERS_QUEUE)
export class SyncTokenHoldersQueue {
  private readonly logger = new Logger(SyncTokenHoldersQueue.name);
  private readonly jobTimeoutMs = Number(
    process.env.SYNC_TOKEN_HOLDERS_JOB_TIMEOUT_MS || 180_000,
  );

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
    const startedAt = Date.now();
    try {
      await Promise.race([
        this.tokenService.loadAndSaveTokenHoldersFromMdw(job.data.saleAddress),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `SyncTokenHoldersQueue timeout after ${this.jobTimeoutMs}ms`,
                ),
              ),
            this.jobTimeoutMs,
          ),
        ),
      ]);
      this.logger.debug(
        `SyncTokenHoldersQueue->completed:${job.data.saleAddress} (${Date.now() - startedAt}ms)`,
      );
    } catch (error: any) {
      this.logger.error(
        `SyncTokenHoldersQueue->error:${job.data.saleAddress} (${Date.now() - startedAt}ms)`,
        error,
        error.stack,
      );
      throw error;
    }
  }
}

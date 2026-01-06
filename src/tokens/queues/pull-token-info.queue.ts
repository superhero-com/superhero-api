import { TokensService } from '@/tokens/tokens.service';
import { Encoded } from '@aeternity/aepp-sdk';
import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { PULL_TOKEN_INFO_QUEUE, SYNC_TOKEN_HOLDERS_QUEUE } from './constants';

export interface IPullTokenInfoQueue {
  saleAddress: Encoded.ContractAddress;
  shouldBroadcast?: boolean;
}

@Processor(PULL_TOKEN_INFO_QUEUE)
export class PullTokenInfoQueue {
  private readonly logger = new Logger(PullTokenInfoQueue.name);

  constructor(
    @InjectQueue(SYNC_TOKEN_HOLDERS_QUEUE)
    private readonly syncTokenHoldersQueue: Queue,

    private tokenService: TokensService,
  ) {
    //
  }

  @Process({
    concurrency: 5,
  })
  async process(job: Job<IPullTokenInfoQueue>) {
    this.logger.log(`PullTokenInfoQueue->started:${job.data.saleAddress}`);
    try {
      const token = await this.tokenService.getToken(job.data.saleAddress);
      await this.tokenService.syncTokenPrice(token);
      this.logger.debug(
        `PullTokenInfoQueue->completed:${job.data.saleAddress}`,
      );
      // void this.syncTokenHoldersQueue.add(
      //   {
      //     saleAddress: job.data.saleAddress,
      //   },
      //   {
      //     jobId: `syncTokenHolders-${job.data.saleAddress}`,
      //     removeOnComplete: true,
      //   },
      // );
    } catch (error) {
      this.logger.error(`PullTokenInfoQueue->error`, error);
    }
  }
}

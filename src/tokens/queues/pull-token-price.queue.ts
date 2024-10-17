import { Encoded } from '@aeternity/aepp-sdk';
import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { TokensService } from 'src/tokens/tokens.service';
import {
  PULL_TOKEN_PRICE_QUEUE,
  SYNC_TOKEN_HOLDERS_QUEUE,
  SYNC_TOKENS_RANKS_QUEUE,
} from './constants';

export interface IPullTokenPriceQueue {
  saleAddress: Encoded.ContractAddress;
  shouldBroadcast?: boolean;
}

@Processor(PULL_TOKEN_PRICE_QUEUE)
export class PullTokenPriceQueue {
  private readonly logger = new Logger(PullTokenPriceQueue.name);

  constructor(
    @InjectQueue(SYNC_TOKENS_RANKS_QUEUE)
    private readonly syncTokensRanksQueue: Queue,

    @InjectQueue(SYNC_TOKEN_HOLDERS_QUEUE)
    private readonly syncTokenHoldersQueue: Queue,

    private tokenService: TokensService,
  ) {}

  @Process()
  async process(job: Job<IPullTokenPriceQueue>) {
    this.logger.log(`PullTokenPriceQueue->started:${job.data.saleAddress}`);
    try {
      const token = await this.tokenService.getToken(job.data.saleAddress);
      await this.tokenService.syncTokenPrice(token);
      this.logger.debug(
        `PullTokenPriceQueue->completed:${job.data.saleAddress}`,
      );
    } catch (error) {
      this.logger.error(`PullTokenPriceQueue->error`, error);
    }

    if (job.data.shouldBroadcast) {
      void this.syncTokensRanksQueue.add({});
      void this.syncTokenHoldersQueue.add({
        saleAddress: job.data.saleAddress,
      });
    }
  }
}

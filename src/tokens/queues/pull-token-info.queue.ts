import { Encoded } from '@aeternity/aepp-sdk';
import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { TokensService } from 'src/tokens/tokens.service';
import {
  PULL_TOKEN_INFO_QUEUE,
  SYNC_TOKEN_HOLDERS_QUEUE,
  SYNC_TOKENS_RANKS_QUEUE,
} from './constants';
import { SYNC_TRANSACTIONS_QUEUE } from 'src/transactions/queues/constants';

export interface IPullTokenInfoQueue {
  saleAddress: Encoded.ContractAddress;
  shouldBroadcast?: boolean;
}

@Processor(PULL_TOKEN_INFO_QUEUE)
export class PullTokenInfoQueue {
  private readonly logger = new Logger(PullTokenInfoQueue.name);

  constructor(
    @InjectQueue(SYNC_TOKENS_RANKS_QUEUE)
    private readonly syncTokensRanksQueue: Queue,

    @InjectQueue(SYNC_TOKEN_HOLDERS_QUEUE)
    private readonly syncTokenHoldersQueue: Queue,

    @InjectQueue(SYNC_TRANSACTIONS_QUEUE)
    private readonly syncTransactionsQueue: Queue,

    private tokenService: TokensService,
  ) {}

  @Process()
  async process(job: Job<IPullTokenInfoQueue>) {
    this.logger.log(`PullTokenInfoQueue->started:${job.data.saleAddress}`);
    try {
      const token = await this.tokenService.getToken(job.data.saleAddress);
      await this.tokenService.syncTokenPrice(token);
      this.logger.debug(
        `PullTokenInfoQueue->completed:${job.data.saleAddress}`,
      );
      void this.syncTokensRanksQueue.add(
        {},
        {
          jobId: `syncTokensRanks-${job.data.saleAddress}`,
          removeOnComplete: true,
        },
      );
      void this.syncTokenHoldersQueue.add(
        {
          saleAddress: job.data.saleAddress,
        },
        {
          jobId: `syncTokenHolders-${job.data.saleAddress}`,
          removeOnComplete: true,
        },
      );
      void this.syncTransactionsQueue.add(
        {
          saleAddress: job.data.saleAddress,
        },
        {
          jobId: `syncTokenTransactions-${job.data.saleAddress}`,
        },
      );
    } catch (error) {
      this.logger.error(`PullTokenInfoQueue->error`, error);
    }
  }
}

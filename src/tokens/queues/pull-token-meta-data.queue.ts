import { Encoded } from '@aeternity/aepp-sdk';
import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { TokensService } from 'src/tokens/tokens.service';
import { PULL_TOKEN_META_DATA_QUEUE } from './constants';

export interface IPullTokenMetaDataQueue {
  saleAddress: Encoded.ContractAddress;
}

@Processor(PULL_TOKEN_META_DATA_QUEUE)
export class PullTokenMetaDataQueue {
  private readonly logger = new Logger(PullTokenMetaDataQueue.name);

  constructor(private tokenService: TokensService) {
    //
  }

  @Process()
  async process(job: Job<IPullTokenMetaDataQueue>) {
    this.logger.log(`PullTokenMetaDataQueue->started:${job.data.saleAddress}`);
    try {
      const token = await this.tokenService.getToken(job.data.saleAddress);
      // await this.loadAndSaveTokenMetaData(job.data.saleAddress);
      this.logger.debug(
        `PullTokenMetaDataQueue->completed:${job.data.saleAddress} ->${token.id}`,
      );
    } catch (error) {
      this.logger.error(`PullTokenMetaDataQueue->error`, error);
    }
  }
}

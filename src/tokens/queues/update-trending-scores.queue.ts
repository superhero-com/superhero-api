import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { TokensService } from '../tokens.service';
import { UPDATE_TRENDING_SCORES_QUEUE } from './constants';

export interface IUpdateTrendingScoresQueue {
  symbol: string;
}

@Processor(UPDATE_TRENDING_SCORES_QUEUE)
export class UpdateTrendingScoresQueue {
  private readonly logger = new Logger(UpdateTrendingScoresQueue.name);

  constructor(private readonly tokenService: TokensService) {
    //
  }

  @Process({
    concurrency: 5,
  })
  async process(job: Job<IUpdateTrendingScoresQueue>) {
    const { symbol } = job.data;
    try {
      await this.tokenService.updateTrendingScoresForSymbols([symbol]);
    } catch (error) {
      this.logger.error(`UpdateTrendingScoresQueue->error:${symbol}`, error);
      throw error;
    }
  }
}

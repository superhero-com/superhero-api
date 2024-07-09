import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Token } from 'src/tokens/entities/token.entity';
import { Repository } from 'typeorm';
import { SYNC_TOKENS_RANKS_QUEUE } from './constants';

export interface ISyncTokensRanksQueue {
  //
}

@Processor(SYNC_TOKENS_RANKS_QUEUE)
export class SyncTokensRanksQueue {
  private readonly logger = new Logger(SyncTokensRanksQueue.name);
  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,
  ) {
    //
  }

  @Process()
  async process() {
    this.logger.log(`SyncTokensRanksQueue->started`);
    try {
      await this.updateTokensRanking();
      this.logger.debug(`SyncTokensRanksQueue->completed`);
    } catch (error) {
      this.logger.error(`SyncTokensRanksQueue->error`, error);
    }
  }

  async updateTokensRanking() {
    const tokens = await this.tokensRepository
      .createQueryBuilder('tokens')
      .orderBy('tokens.market_cap', 'DESC')
      .getMany();

    tokens.forEach((token, index) => {
      this.tokensRepository.update(token.id, { rank: index + 1 });
    });
  }
}

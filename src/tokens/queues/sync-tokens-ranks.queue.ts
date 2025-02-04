import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { Token } from '@/tokens/entities/token.entity';
import { Repository } from 'typeorm';
import { SYNC_TOKENS_RANKS_QUEUE } from './constants';

@Processor(SYNC_TOKENS_RANKS_QUEUE)
export class SyncTokensRanksQueue {
  private readonly logger = new Logger(SyncTokensRanksQueue.name);
  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,
    private communityFactoryService: CommunityFactoryService,
  ) {
    //
  }

  @Process()
  async process() {
    this.logger.log(`SyncTokensRanksQueue->started`);
    try {
      await this.updateTokensRanking();
      const factory = await this.communityFactoryService.getCurrentFactory();
      for (const collection of Object.keys(factory.collections)) {
        await this.updateTokenCollectionRankings(collection);
      }
      this.logger.debug(`SyncTokensRanksQueue->completed`);
    } catch (error) {
      this.logger.error(`SyncTokensRanksQueue->error`, error);
    }
  }

  async updateTokensRanking() {
    const factory = await this.communityFactoryService.getCurrentFactory();
    const tokens = await this.tokensRepository
      .createQueryBuilder('tokens')
      .where('tokens.factory_address = :factory', { factory: factory.address })
      .orderBy('tokens.market_cap', 'DESC')
      .getMany();

    tokens.forEach((token, index) => {
      this.tokensRepository.update(token.id, { rank: index + 1 });
    });
  }

  async updateTokenCollectionRankings(collection: string) {
    const factory = await this.communityFactoryService.getCurrentFactory();
    const tokens = await this.tokensRepository
      .createQueryBuilder('tokens')
      .where('tokens.factory_address = :factory', { factory: factory.address })
      .where('tokens.collection = :collection', { collection })
      .orderBy('tokens.market_cap', 'DESC')
      .getMany();

    tokens.forEach((token, index) => {
      this.tokensRepository.update(token.id, { collection_rank: index + 1 });
    });
  }
}

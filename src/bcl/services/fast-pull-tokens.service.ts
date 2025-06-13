import { CommunityFactoryService } from '@/ae/community-factory.service';
import { SyncBlocksService } from '@/bcl/services/sync-blocks.service';
import { SyncTransactionsService } from '@/bcl/services/sync-transactions.service';
import { ACTIVE_NETWORK } from '@/configs/network';
import { Token } from '@/tokens/entities/token.entity';
import { TokensService } from '@/tokens/tokens.service';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';

@Injectable()
export class FastPullTokensService {
  pullingTokens = false;
  private readonly logger = new Logger(FastPullTokensService.name);

  constructor(
    private readonly tokensService: TokensService,
    private communityFactoryService: CommunityFactoryService,
    private syncTransactionsService: SyncTransactionsService,

    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,

    private syncBlocksService: SyncBlocksService,
  ) {
    this.fastPullTokens();
  }

  isPullingLatestCreatedTokens = false;
  @Cron(CronExpression.EVERY_10_MINUTES)
  async pullLatestCreatedTokens() {
    if (this.isPullingLatestCreatedTokens) {
      return;
    }
    this.isPullingLatestCreatedTokens = true;
    const factory = await this.communityFactoryService.getCurrentFactory();
    if (this.syncBlocksService.latestBlockNumber < 100) {
      this.isPullingLatestCreatedTokens = false;
      return;
    }

    const query: Record<string, string | number> = {
      direction: 'backward',
      limit: 100,
      scope: `gen:${this.syncBlocksService.latestBlockNumber - 100}-${this.syncBlocksService.latestBlockNumber}`,
      type: 'contract_call',
      contract: factory.address,
    };
    const queryString = Object.keys(query)
      .map((key) => key + '=' + query[key])
      .join('&');

    const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions?${queryString}`;
    await this.tokensService.loadCreatedCommunityFromMdw(url, factory);
    this.isPullingLatestCreatedTokens = false;
  }

  @Cron(CronExpression.EVERY_6_HOURS)
  async fastPullTokens() {
    if (this.pullingTokens) {
      return;
    }
    this.pullingTokens = true;

    const factory = await this.communityFactoryService.getCurrentFactory();

    const query: Record<string, string | number> = {
      direction: 'forward',
      limit: 100,
      type: 'contract_call',
      contract: factory.address,
    };
    const queryString = Object.keys(query)
      .map((key) => key + '=' + query[key])
      .join('&');
    const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions?${queryString}`;
    this.logger.log('////////////////////////////////////////////////////');
    this.logger.log('////////////////////////////////////////////////////');
    this.logger.log(`FastPullTokensService->fetchAndSyncTransactions: ${url}`);
    this.logger.log('////////////////////////////////////////////////////');
    this.logger.log('////////////////////////////////////////////////////');
    // await this.syncTransactionsService.fetchAndSyncTransactions(url);
    await this.tokensService.loadCreatedCommunityFromMdw(url, factory);

    // pull all tokens where price is 0, order by total_supply desc
    const tokens = await this.tokensRepository.find({
      where: {
        price: LessThanOrEqual(1),
      },
      order: {
        total_supply: 'DESC',
      },
    });

    for (const token of tokens) {
      try {
        const liveTokenData = await this.tokensService.getTokeLivePrice(token);
        await this.tokensRepository.update(token.id, liveTokenData);
      } catch (error: any) {
        this.logger.error(
          `FastPullTokensService: ${token.id} - ${error.message}`,
          error.stack,
        );
      }
    }

    this.pullingTokens = false;
  }
}

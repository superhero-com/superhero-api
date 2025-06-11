import { CommunityFactoryService } from '@/ae/community-factory.service';
import { ACTIVE_NETWORK } from '@/configs/network';
import { Token } from '@/tokens/entities/token.entity';
import { TokensService } from '@/tokens/tokens.service';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { CommunityFactory } from 'bctsl-sdk';
import { LessThanOrEqual, Repository } from 'typeorm';

@Injectable()
export class FastPullTokensService {
  pullingTokens = false;
  factoryContract: CommunityFactory;
  private readonly logger = new Logger(FastPullTokensService.name);

  constructor(
    private readonly tokensService: TokensService,
    private communityFactoryService: CommunityFactoryService,

    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,
  ) {
    this.fastPullTokens();
  }

  @Cron(CronExpression.EVERY_6_HOURS)
  async fastPullTokens() {
    if (this.pullingTokens) {
      return;
    }
    this.pullingTokens = true;

    const factory = await this.communityFactoryService.getCurrentFactory();
    this.factoryContract = await this.communityFactoryService.loadFactory(
      factory.address,
    );

    await this.tokensService.loadCreatedCommunityFromMdw(
      `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions?contract=${factory.address}&limit=100`,
      factory,
    );

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

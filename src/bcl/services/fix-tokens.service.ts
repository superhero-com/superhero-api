import { Token } from '@/tokens/entities/token.entity';
import { TokensService } from '@/tokens/tokens.service';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

@Injectable()
export class FixTokensService {
  fixingTokens = false;
  private readonly logger = new Logger(FixTokensService.name);

  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,

    private readonly tokensService: TokensService,
  ) {
    //
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async fixTokensAddresses() {
    if (this.fixingTokens) {
      return;
    }
    this.fixingTokens = true;

    // find all tokens where address is null
    const tokens = await this.tokensRepository.find({
      where: {
        address: IsNull(),
      },
    });
    for (const token of tokens) {
      try {
        await this.tokensService.loadTokenContractAndUpdateMintAddress(token);
      } catch (error: any) {
        this.logger.error(
          `FixTokensService: ${token.id} - ${error.message}`,
          error.stack,
        );
      }
    }
    this.fixingTokens = false;
  }
}

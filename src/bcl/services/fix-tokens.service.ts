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

  @Cron(CronExpression.EVERY_5_MINUTES)
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
      order: {
        total_supply: 'DESC',
      },
    });
    for (const token of tokens) {
      try {
        await this.tokensService.getTokenAex9Address(token);
      } catch (error: any) {
        this.logger.error(
          `FixTokensService: ${token.sale_address} - ${error.message}`,
          error.stack,
        );
        await this.tokensRepository.delete(token.sale_address);
      }
    }
    this.fixingTokens = false;
  }
}

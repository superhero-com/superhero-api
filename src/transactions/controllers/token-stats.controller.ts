import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import moment, { Moment } from 'moment';
import { Transaction } from 'src/transactions/entities/transaction.entity';
import { Repository } from 'typeorm';
import { TokenHolder } from '../../tokens/entities/token-holders.entity';
import { Token } from '../../tokens/entities/token.entity';
import { TokensService } from '../../tokens/tokens.service';
import { TokenPriceMovementDto } from '../dto/token-stats.dto';

@Controller('api/tokens')
@ApiTags('Tokens')
export class TokenStatsController {
  constructor(
    @InjectRepository(Token)
    private readonly tokensRepository: Repository<Token>,

    @InjectRepository(Transaction)
    private readonly transactionsRepository: Repository<Transaction>,

    @InjectRepository(TokenHolder)
    private readonly tokenHolderRepository: Repository<TokenHolder>,

    private readonly tokensService: TokensService,
  ) {
    //
  }

  @ApiOperation({ operationId: 'stats' })
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address or name',
  })
  @Get(':address/stats')
  @ApiResponse({
    type: TokenPriceMovementDto,
  })
  async stats(@Param('address') address: string) {
    const token = await this.tokensService.getToken(address);

    const past_24h = await this.getTokenPriceMovement(
      token,
      moment().subtract(24, 'hours'),
    );

    const past_7d = await this.getTokenPriceMovement(
      token,
      moment().subtract(7, 'days'),
    );

    const past_30d = await this.getTokenPriceMovement(
      token,
      moment().subtract(30, 'days'),
    );

    const all_time = await this.getTokenPriceMovement(
      token,
      moment(token.created_at).subtract(30, 'days'),
    );
    return {
      token_id: token.id,
      past_24h,
      past_7d,
      past_30d,
      all_time,
    };
  }

  async getTokenPriceMovement(token: Token, date: Moment) {
    const transactionsQuery = await this.transactionsRepository
      .createQueryBuilder('transactions')
      .where('transactions.tokenId = :tokenId', {
        tokenId: token.id,
      })
      .andWhere('transactions.created_at > :date', {
        date: date.toDate(),
      })
      .andWhere("transactions.buy_price->>'ae' != 'NaN'")
      .select([
        "MAX((transactions.buy_price->>'ae')::numeric) as high",
        "MIN((transactions.buy_price->>'ae')::numeric) as low",
      ])
      .getRawOne();

    console.log('transactionsQuery::', transactionsQuery);

    return {
      high: transactionsQuery.high ?? token?.price_data?.ae,
      low: transactionsQuery.low ?? token?.price_data?.ae,
    };
  }
}

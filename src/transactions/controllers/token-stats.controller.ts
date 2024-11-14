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
    const highestPriceQuery = await this.transactionsRepository
      .createQueryBuilder('transactions')
      .where('transactions.tokenId = :tokenId', {
        tokenId: token.id,
      })
      .andWhere('transactions.created_at > :date', {
        date: date.toDate(),
      })
      .andWhere("transactions.buy_price->>'ae' != 'NaN'")
      .orderBy("transactions.buy_price->>'ae'", 'DESC')
      .select([
        "transactions.buy_price->>'ae' as buy_price",
        'transactions.created_at as created_at',
      ])
      .getRawOne();
    const lowestPriceQuery = await this.transactionsRepository
      .createQueryBuilder('transactions')
      .where('transactions.tokenId = :tokenId', {
        tokenId: token.id,
      })
      .andWhere('transactions.created_at > :date', {
        date: date.toDate(),
      })
      .andWhere("transactions.buy_price->>'ae' != 'NaN'")
      .orderBy("transactions.buy_price->>'ae'", 'ASC')
      .select([
        "transactions.buy_price->>'ae' as buy_price",
        'transactions.created_at as created_at',
      ])
      .getRawOne();
    // query first transaction on the token
    const firstTransaction = await this.transactionsRepository
      .createQueryBuilder('transactions')
      .where('transactions.tokenId = :tokenId', {
        tokenId: token.id,
      })
      .andWhere('transactions.created_at > :date', {
        date: date.toDate(),
      })
      .andWhere("transactions.buy_price->>'ae' != 'NaN'")
      .orderBy('transactions.created_at', 'ASC')
      .select([
        "transactions.buy_price->>'ae' as buy_price",
        'transactions.created_at as created_at',
      ])
      .getRawOne();

    const high = highestPriceQuery.buy_price ?? token?.price_data?.ae;
    const low = lowestPriceQuery.buy_price ?? token?.price_data?.ae;

    const firstTransactionPrice =
      firstTransaction?.buy_price ?? token?.price_data?.ae;
    const current_token_price = token?.price_data?.ae;

    const change = current_token_price - firstTransactionPrice;
    const change_percent = (change / current_token_price) * 100;
    const change_direction = change > 0 ? 'up' : 'down';

    return {
      high,
      high_date: highestPriceQuery.created_at,
      low,
      low_date: lowestPriceQuery.created_at,
      change,
      change_percent,
      change_direction,
      current_token_price,
    };
  }
}

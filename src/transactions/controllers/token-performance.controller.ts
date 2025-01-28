import { Controller, Get, Param, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import moment, { Moment } from 'moment';
import { Transaction } from 'src/transactions/entities/transaction.entity';
import { Repository } from 'typeorm';
import { TokenHolder } from '../../tokens/entities/token-holders.entity';
import { Token } from '../../tokens/entities/token.entity';
import { TokensService } from '../../tokens/tokens.service';
import { TokenPriceMovementDto } from '../dto/token-stats.dto';
import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';

@Controller('api/tokens')
@UseInterceptors(CacheInterceptor)
@ApiTags('Tokens')
export class TokenPerformanceController {
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

  @ApiOperation({ operationId: 'performance' })
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address or name',
  })
  @Get(':address/performance')
  @CacheTTL(60 * 1000)
  @ApiResponse({
    type: TokenPriceMovementDto,
  })
  async performance(@Param('address') address: string) {
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
    const startingTransaction = await this.transactionsRepository
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
        'transactions.buy_price as buy_price',
        'transactions.created_at as created_at',
      ])
      .getRawOne();
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
        'transactions.buy_price as buy_price',
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
        'transactions.buy_price as buy_price',
        'transactions.created_at as created_at',
      ])
      .getRawOne();

    const current = startingTransaction?.buy_price ?? token?.price_data;
    const high = highestPriceQuery?.buy_price ?? token?.price_data;
    const low = lowestPriceQuery?.buy_price ?? token?.price_data;

    const current_token_price = token?.price_data?.ae;

    const high_change = current_token_price - high?.ae;
    const high_change_percent = (high_change / current_token_price) * 100;
    const high_change_direction = high_change > 0 ? 'up' : 'down';

    const low_change = current_token_price - low?.ae;
    const low_change_percent = (low_change / current_token_price) * 100;
    const low_change_direction = low_change > 0 ? 'up' : 'down';

    const current_change = current_token_price - current?.ae;
    const current_change_percent = (current_change / current_token_price) * 100;
    const current_change_direction = current_change > 0 ? 'up' : 'down';

    return {
      current,
      current_date: startingTransaction?.created_at,
      current_change,
      current_change_percent,
      current_change_direction,

      high,
      high_date: highestPriceQuery?.created_at,
      high_change,
      high_change_percent,
      high_change_direction,

      low,
      low_date: lowestPriceQuery?.created_at,
      low_change,
      low_change_percent,
      low_change_direction,

      current_token_price,
    };
  }
}

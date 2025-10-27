import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import {
  Controller,
  Get,
  Param,
  UseInterceptors,
  NotFoundException,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import moment, { Moment } from 'moment';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { Repository } from 'typeorm';
import { Token } from '@/tokens/entities/token.entity';
import { TokensService } from '@/tokens/tokens.service';
import { TokenPriceMovementDto } from '@/transactions/dto/token-stats.dto';
import { TokenPerformanceService } from '../services/token-performance.service';

@Controller('tokens')
@UseInterceptors(CacheInterceptor)
@ApiTags('Tokens')
export class TokenPerformanceController {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactionsRepository: Repository<Transaction>,

    private readonly tokensService: TokensService,
    private readonly tokenPerformanceService: TokenPerformanceService,
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

    if (!token) {
      throw new NotFoundException('Token not found');
    }

    // Check if we have recent cached performance data
    const cachedPerformance =
      await this.tokenPerformanceService.getPerformanceData(token.sale_address);

    if (cachedPerformance) {
      // Check if data is recent (within 1 hour)
      const isRecent =
        await this.tokenPerformanceService.isPerformanceDataRecent(
          token.sale_address,
          1,
        );

      if (isRecent) {
        // Return cached data
        const performanceData =
          this.tokenPerformanceService.convertToPerformanceDto(
            cachedPerformance,
          );

        return {
          token_id: token.sale_address,
          past_24h: performanceData.past_24h,
          past_7d: performanceData.past_7d,
          past_30d: performanceData.past_30d,
          all_time: performanceData.all_time,
        };
      }
    }

    // Calculate fresh performance data
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

    // Add last_updated field to performance data
    const performanceDataWithTimestamp = {
      past_24h: { ...past_24h, last_updated: new Date() },
      past_7d: { ...past_7d, last_updated: new Date() },
      past_30d: { ...past_30d, last_updated: new Date() },
      all_time: { ...all_time, last_updated: new Date() },
    };

    // Store the calculated performance data
    await this.tokenPerformanceService.storePerformanceData(
      token,
      performanceDataWithTimestamp,
    );

    return {
      token_id: token.sale_address,
      past_24h: performanceDataWithTimestamp.past_24h,
      past_7d: performanceDataWithTimestamp.past_7d,
      past_30d: performanceDataWithTimestamp.past_30d,
      all_time: performanceDataWithTimestamp.all_time,
    };
  }

  async getTokenPriceMovement(token: Token, date: Moment) {
    const startingTransaction = await this.transactionsRepository
      .createQueryBuilder('transactions')
      .where('transactions.sale_address = :sale_address', {
        sale_address: token.sale_address,
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
      .where('transactions.sale_address = :sale_address', {
        sale_address: token.sale_address,
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
      .where('transactions.sale_address = :sale_address', {
        sale_address: token.sale_address,
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

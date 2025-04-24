import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import { Controller, Get, Query, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DailyTokenCountDto } from './dto/daily-token-count.dto';
import { MarketCapSumDto } from './dto/market-cap-sum.dto';
import { Token } from './entities/token.entity';

@Controller('api/analytics')
@UseInterceptors(CacheInterceptor)
@ApiTags('Analytics')
export class AnalyticTokensController {
  constructor(
    @InjectRepository(Token)
    private readonly tokensRepository: Repository<Token>,

    private readonly aePricingService: AePricingService,
  ) {
    //
  }

  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiQuery({ name: 'end_date', type: 'string', required: false })
  @ApiOperation({
    operationId: 'listDailyCreatedTokensCount',
    description: 'Returns the count of tokens created per day',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns the count of tokens created per day',
    type: [DailyTokenCountDto],
  })
  @CacheTTL(1000)
  @Get('daily-created-tokens-count')
  async listDailyCreatedTokensCount(
    @Query('start_date') start_date?: string,
    @Query('end_date') end_date?: string,
  ): Promise<DailyTokenCountDto[]> {
    const queryBuilder = this.tokensRepository.createQueryBuilder('token');

    // Select date and count of tokens for each day
    queryBuilder
      .select('DATE(token.created_at) as date')
      .addSelect('COUNT(*) as count')
      .groupBy('DATE(token.created_at)')
      .orderBy('DATE(token.created_at)', 'ASC');

    if (start_date) {
      queryBuilder.where('token.created_at >= :start_date', { start_date });
    }
    if (end_date) {
      queryBuilder.andWhere('token.created_at <= :end_date', { end_date });
    }

    const results = await queryBuilder.getRawMany();

    return results.map((result) => ({
      date: result.date,
      count: parseInt(result.count, 10),
    }));
  }

  @ApiOperation({
    operationId: 'getTotalMarketCap',
    description: 'Returns the sum of market caps for all tokens',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns the sum of market caps for all tokens',
    type: MarketCapSumDto,
  })
  @CacheTTL(1000)
  @Get('total-market-cap')
  async getTotalMarketCap(): Promise<MarketCapSumDto> {
    const queryBuilder = this.tokensRepository.createQueryBuilder('token');

    // Select sum of market_cap for all tokens
    const result = await queryBuilder
      .select('SUM(token.market_cap)', 'sum')
      .where('token.unlisted = false')
      .getRawOne();

    const sum = result.sum || '0';
    const sum_data = await this.aePricingService.getPriceData(sum);

    return {
      sum,
      sum_data,
    };
  }
}

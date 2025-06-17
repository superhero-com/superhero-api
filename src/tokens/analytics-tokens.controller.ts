import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import moment from 'moment';
import { Repository } from 'typeorm';
import { DailyTokenCountDto } from './dto/daily-token-count.dto';
import { MarketCapSumDto } from './dto/market-cap-sum.dto';
import { Token } from './entities/token.entity';

@Controller('analytics')
@ApiTags('Analytics')
export class AnalyticTokensController {
  constructor(
    @InjectRepository(Token)
    private readonly tokensRepository: Repository<Token>,

    private readonly aePricingService: AePricingService,

    private readonly communityFactoryService: CommunityFactoryService,
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
  @Get('daily-created-tokens-count')
  async listDailyCreatedTokensCount(
    @Query('start_date') start_date?: string,
    @Query('end_date') end_date?: string,
  ): Promise<DailyTokenCountDto[]> {
    const defaultStartDate = moment().subtract(7, 'days').startOf('day');
    const defaultEndDate = moment().add(1, 'days').endOf('day');

    const startDate = start_date ? moment(start_date) : defaultStartDate;
    const endDate = end_date ? moment(end_date) : defaultEndDate;
    const queryBuilder = this.tokensRepository.createQueryBuilder('token');

    // Select date and count of tokens for each day
    queryBuilder
      .select('DATE(token.created_at) as date')
      .addSelect('COUNT(*) as count')
      .groupBy('DATE(token.created_at)')
      .orderBy('DATE(token.created_at)', 'ASC');

    if (startDate) {
      queryBuilder.where('token.created_at >= :start_date', {
        start_date: startDate.toDate(),
      });
    }
    if (endDate) {
      queryBuilder.andWhere('token.created_at <= :end_date', {
        end_date: endDate.toDate(),
      });
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

  @ApiOperation({
    operationId: 'getTotalCreatedTokens',
    description: 'Returns the total number of tokens created',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns the total number of tokens created',
    type: Number,
  })
  @Get('total-created-tokens')
  async getTotalCreatedTokens(): Promise<number> {
    const queryBuilder = this.tokensRepository.createQueryBuilder('token');
    const factory = await this.communityFactoryService.getCurrentFactory();
    queryBuilder.where('token.factory_address = :address', {
      address: factory.address,
    });

    return await queryBuilder.getCount();
  }
}

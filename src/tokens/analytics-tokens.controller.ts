import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import { Controller, Get, Query, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DailyTokenCountDto } from './dto/daily-token-count.dto';
import { Token } from './entities/token.entity';

@Controller('api/analytics')
@UseInterceptors(CacheInterceptor)
@ApiTags('Analytics')
export class AnalyticTokensController {
  constructor(
    @InjectRepository(Token)
    private readonly tokensRepository: Repository<Token>,
  ) {
    //
  }

  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiQuery({ name: 'end_date', type: 'string', required: false })
  @ApiOperation({ operationId: 'listDailyTokenCount' })
  @ApiResponse({
    status: 200,
    description: 'Returns the count of tokens created per day',
    type: [DailyTokenCountDto],
  })
  @CacheTTL(1000)
  @Get('daily-token-count')
  async listDailyTokenCount(
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
}

import { TokensService } from '@/tokens/tokens.service';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import moment from 'moment';
import { Repository } from 'typeorm';
import { Transaction } from '../entities/transaction.entity';
import {
  DailyTradeVolumeQueryDto,
  DailyTradeVolumeResultDto,
  DailyUniqueActiveUsersQueryDto,
  DailyUniqueActiveUsersResultDto,
  TotalUniqueUsersResultDto,
} from '../dto/analytics-transactions.dto';
import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { DailyMarketCapSumDto } from '@/tokens/dto/daily-market-cap-sum.dto';
import { CacheTTL } from '@nestjs/cache-manager';

@Controller('api/analytics')
@ApiTags('Analytics')
export class AnalyticsTransactionsController {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactionsRepository: Repository<Transaction>,
    private tokenService: TokensService,

    private readonly aePricingService: AePricingService,
  ) {}

  @ApiOperation({
    operationId: 'dailyTradeVolume',
    description: 'Returns the daily trade volume for a given token or account',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns daily trade volume data',
    type: [DailyTradeVolumeResultDto],
  })
  @Get('daily-trade-volume')
  async dailyTradeVolume(
    @Query() query: DailyTradeVolumeQueryDto,
  ): Promise<DailyTradeVolumeResultDto[]> {
    // If no dates provided, default to last 7 days
    const defaultStartDate = moment().subtract(7, 'days').startOf('day');
    const defaultEndDate = moment().endOf('day');

    const startDate = query.start_date
      ? moment(query.start_date).startOf('day')
      : defaultStartDate;
    const endDate = query.end_date
      ? moment(query.end_date).endOf('day')
      : defaultEndDate;

    console.log('Query parameters:', {
      start_date: startDate.format('YYYY-MM-DD'),
      end_date: endDate.format('YYYY-MM-DD'),
      token_address: query.token_address,
      account_address: query.account_address,
    });

    // First, let's check if we have any transactions in the date range
    const countQuery = this.transactionsRepository
      .createQueryBuilder('transactions')
      .where('transactions.created_at >= :start_date', {
        start_date: startDate.toDate(),
      })
      .andWhere('transactions.created_at <= :end_date', {
        end_date: endDate.toDate(),
      });

    const totalCount = await countQuery.getCount();
    console.log('Total transactions in date range:', totalCount);

    // Let's check the actual data structure
    const sampleTransactions = await this.transactionsRepository
      .createQueryBuilder('transactions')
      .select([
        'transactions.amount',
        'transactions.created_at',
        'transactions.volume',
      ])
      .limit(5)
      .getRawMany();

    console.log('Sample transactions:', sampleTransactions);

    // Build the main query
    const queryBuilder = this.transactionsRepository
      .createQueryBuilder('transactions')
      .select([
        "DATE_TRUNC('day', transactions.created_at) as date",
        "COALESCE(SUM(CAST(NULLIF(transactions.amount->>'ae', 'NaN') AS DECIMAL)), 0) as volume_ae",
        'COUNT(*) as transaction_count',
      ])
      .where('transactions.created_at >= :start_date', {
        start_date: startDate.toDate(),
      })
      .andWhere('transactions.created_at <= :end_date', {
        end_date: endDate.toDate(),
      })
      .groupBy("DATE_TRUNC('day', transactions.created_at)")
      .orderBy('date', 'DESC');

    // Add token filter if provided
    if (query.token_address) {
      const token = await this.tokenService.getToken(query.token_address);
      console.log('Token filter:', token);
      if (token) {
        queryBuilder.andWhere('transactions."tokenId" = :tokenId', {
          tokenId: token.id,
        });
      }
    }

    // Add account filter if provided
    if (query.account_address) {
      console.log('Account filter:', query.account_address);
      queryBuilder.andWhere('transactions.address = :account_address', {
        account_address: query.account_address,
      });
    }

    return queryBuilder.getRawMany();
  }

  @ApiOperation({
    operationId: 'listDailyUniqueActiveUsers',
    description: 'Returns the daily unique active users for a given token',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns daily unique active users data',
    type: [DailyUniqueActiveUsersResultDto],
  })
  @Get('daily-unique-active-users')
  async dailyUniqueActiveUsers(
    @Query() query: DailyUniqueActiveUsersQueryDto,
  ): Promise<DailyUniqueActiveUsersResultDto[]> {
    // If no dates provided, default to last 7 days
    const defaultStartDate = moment().subtract(7, 'days').startOf('day');
    const defaultEndDate = moment().endOf('day');

    const startDate = query.start_date
      ? moment(query.start_date).startOf('day')
      : defaultStartDate;
    const endDate = query.end_date
      ? moment(query.end_date).endOf('day')
      : defaultEndDate;

    console.log('Query parameters:', {
      start_date: startDate.format('YYYY-MM-DD'),
      end_date: endDate.format('YYYY-MM-DD'),
      token_address: query.token_address,
    });

    // Build the query to count unique users per day
    const queryBuilder = this.transactionsRepository
      .createQueryBuilder('transactions')
      .select([
        "DATE_TRUNC('day', transactions.created_at) as date",
        'COUNT(DISTINCT transactions.address) as active_users',
      ])
      .where('transactions.created_at >= :start_date', {
        start_date: startDate.toDate(),
      })
      .andWhere('transactions.created_at <= :end_date', {
        end_date: endDate.toDate(),
      })
      .groupBy("DATE_TRUNC('day', transactions.created_at)")
      .orderBy('date', 'DESC');

    // Add token filter if provided
    if (query.token_address) {
      console.log('Token filter:', query.token_address);
      const token = await this.tokenService.getToken(query.token_address);
      console.log('Token filter:', token);
      if (token) {
        queryBuilder.andWhere('transactions."tokenId" = :tokenId', {
          tokenId: token.id,
        });
      }
    }

    return queryBuilder.getRawMany();
  }

  @ApiOperation({
    operationId: 'totalUniqueUsers',
    description: 'Returns the total number of unique users across the entire system',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns total unique users count',
    type: TotalUniqueUsersResultDto,
  })
  @Get('total-unique-users')
  async totalUniqueUsers(): Promise<TotalUniqueUsersResultDto> {
    // Count all unique users across the entire system
    const queryBuilder = this.transactionsRepository
      .createQueryBuilder('transactions')
      .select('COUNT(DISTINCT transactions.address) as total_users');

    const result = await queryBuilder.getRawOne();
    return { total_users: parseInt(result.total_users) || 0 };
  }

  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiQuery({ name: 'end_date', type: 'string', required: false })
  @ApiOperation({
    operationId: 'listDailyMarketCapSum',
    description: 'Returns the sum of market caps for all tokens per day',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns the sum of market caps for all tokens per day',
    type: [DailyMarketCapSumDto],
  })
  @CacheTTL(1000)
  @Get('daily-market-cap-sum')
  async listDailyMarketCapSum(
    @Query('start_date') start_date?: string,
    @Query('end_date') end_date?: string,
  ): Promise<DailyMarketCapSumDto[]> {
    const queryBuilder = this.transactionsRepository.createQueryBuilder('transaction');

    // Select date and sum of market_cap for each day
    queryBuilder
      .select('DATE(transaction.created_at) as date')
      .addSelect('MAX(transaction.market_cap->>\'ae\') as sum')
      .where('transaction.market_cap->>\'ae\' IS NOT NULL')
      .groupBy('DATE(transaction.created_at)')
      .orderBy('DATE(transaction.created_at)', 'ASC');

    if (start_date) {
      queryBuilder.andWhere('transaction.created_at >= :start_date', { start_date });
    }
    if (end_date) {
      queryBuilder.andWhere('transaction.created_at <= :end_date', { end_date });
    }

    const results = await queryBuilder.getRawMany();

    // Convert each result to include price data
    const dailySums = await Promise.all(
      results.map(async (result) => {
        const sum = result.sum || '0';
        return {
          date: result.date,
          sum,
        };
      }),
    );

    return dailySums;
  }
}

import { TokensService } from '@/tokens/tokens.service';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import moment from 'moment';
import { In, Repository } from 'typeorm';
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
import { Token } from '@/tokens/entities/token.entity';
@Controller('api/analytics')
@ApiTags('Analytics')
export class AnalyticsTransactionsController {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactionsRepository: Repository<Transaction>,
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,
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
    description:
      'Returns the total number of unique users across the entire system',
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
  @ApiQuery({ name: 'token_sale_addresses', type: 'array', required: false })
  @CacheTTL(1000)
  @Get('daily-market-cap-sum')
  async listDailyMarketCapSum(
    @Query('start_date') start_date?: string,
    @Query('end_date') end_date?: string,
    @Query('token_sale_addresses') token_sale_addresses?: string[],
  ): Promise<DailyMarketCapSumDto[]> {
    if (token_sale_addresses && !Array.isArray(token_sale_addresses)) {
      token_sale_addresses = [token_sale_addresses];
    }

    const tokensQuery = this.transactionsRepository
      .createQueryBuilder('transaction')
      .select('DISTINCT transaction."tokenId"')
      .where("transaction.market_cap->>'ae' IS NOT NULL");

    if (token_sale_addresses?.length) {
      const tokens = await this.tokensRepository.find({
        where: {
          sale_address: In(token_sale_addresses),
        },
      });
      const uniqueTokenIds = tokens.map((t) => t.id);
      tokensQuery.andWhere('transaction."tokenId" IN (:...tokenIds)', {
        tokenIds: uniqueTokenIds,
      });
    }

    if (start_date) {
      tokensQuery.andWhere('transaction.created_at >= :start_date', {
        start_date,
      });
    }
    if (end_date) {
      tokensQuery.andWhere('transaction.created_at <= :end_date', {
        end_date,
      });
    }

    const tokens = await tokensQuery.getRawMany();
    const tokenIds = tokens.map((t) => t.tokenId);

    // Generate a complete date range
    const startDate = start_date ? new Date(start_date) : new Date();
    const endDate = end_date ? new Date(end_date) : new Date();
    const dateRange = [];
    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      dateRange.push(new Date(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Get market cap data for each token
    const tokenMarketCaps = new Map();
    for (const tokenId of tokenIds) {
      const tokenQuery = this.transactionsRepository
        .createQueryBuilder('transaction')
        .select('DATE(transaction.created_at) as date')
        .addSelect("MAX(transaction.market_cap->>'ae') as sum")
        .where("transaction.market_cap->>'ae' IS NOT NULL")
        .andWhere('transaction."tokenId" = :tokenId', { tokenId })
        .groupBy('DATE(transaction.created_at)')
        .orderBy('DATE(transaction.created_at)', 'ASC');

      if (start_date) {
        tokenQuery.andWhere('transaction.created_at >= :start_date', {
          start_date,
        });
      }
      if (end_date) {
        tokenQuery.andWhere('transaction.created_at <= :end_date', {
          end_date,
        });
      }

      const results = await tokenQuery.getRawMany();

      // Create a map of date to market cap for this token
      const marketCapMap = new Map();
      results.forEach((result) => {
        const value = result.sum;
        // Only store non-NaN values
        if (value && value !== 'NaN' && !isNaN(parseFloat(value))) {
          marketCapMap.set(result.date.toISOString().split('T')[0], value);
        }
      });

      // Fill in missing dates with previous day's value for this token
      let lastKnownValue = '0';
      const filledData = dateRange.map((date) => {
        const dateStr = date.toISOString().split('T')[0];
        const currentValue = marketCapMap.get(dateStr);
        if (
          currentValue &&
          currentValue !== 'NaN' &&
          !isNaN(parseFloat(currentValue))
        ) {
          lastKnownValue = currentValue;
        }
        return {
          date: dateStr,
          sum: lastKnownValue,
        };
      });

      tokenMarketCaps.set(tokenId, filledData);
    }

    // Sum up market caps across all tokens for each day
    const dailySums = dateRange.map((date) => {
      const dateStr = date.toISOString().split('T')[0];
      let totalSum = 0;
      for (const tokenData of tokenMarketCaps.values()) {
        const tokenDayData = tokenData.find((d) => d.date === dateStr);
        if (
          tokenDayData &&
          tokenDayData.sum !== 'NaN' &&
          !isNaN(parseFloat(tokenDayData.sum))
        ) {
          totalSum += parseFloat(tokenDayData.sum);
        }
      }
      return {
        date: dateStr,
        sum: totalSum.toString(),
      };
    });

    return dailySums;
  }
}

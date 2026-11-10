import { TokensService } from '@/tokens/tokens.service';
import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
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
import { Token } from '@/tokens/entities/token.entity';
import {
  createConcurrencyLimiter,
  mapWithConcurrency,
} from '@/utils/concurrency.util';
import { LRUCache } from 'lru-cache';

const MAX_TOKEN_SALE_ADDRESSES = 100;

const MARKET_CAP_SUM_CONCURRENCY = 20;
const MARKET_CAP_SUM_TTL_MS = 20_000;
// A load stuck on a dead connection must not hold its range forever.
const MARKET_CAP_SUM_LOAD_DEADLINE_MS = 5 * 60_000;
const MARKET_CAP_SUM_MAX_RANGES = 100;

interface MarketCapSumEntry {
  sums: Promise<DailyMarketCapSumDto[]>;
  expiresAt: number;
}

@Controller('analytics')
@ApiTags('Analytics')
export class AnalyticsTransactionsController {
  // One request still runs 20 day queries at once, but all requests together
  // can't hold more than 20 of the pool's 40 connections.
  private readonly marketCapSumSlots = createConcurrencyLimiter(
    MARKET_CAP_SUM_CONCURRENCY,
  );
  private readonly marketCapSums = new LRUCache<string, MarketCapSumEntry>({
    max: MARKET_CAP_SUM_MAX_RANGES,
  });

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
    const defaultEndDate = moment().add(1, 'days').endOf('day');

    const startDate = query.start_date
      ? moment(query.start_date)
      : defaultStartDate;
    const endDate = query.end_date ? moment(query.end_date) : defaultEndDate;

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
      const token = await this.tokenService.getToken(query.token_address, true);
      if (token) {
        queryBuilder.andWhere('transactions.sale_address = :sale_address', {
          sale_address: token.sale_address,
        });
      }
    }

    // Add account filter if provided
    if (query.account_address) {
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
    const defaultEndDate = moment().add(1, 'days').endOf('day');

    const startDate = query.start_date
      ? moment(query.start_date)
      : defaultStartDate;
    const endDate = query.end_date ? moment(query.end_date) : defaultEndDate;

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
      const token = await this.tokenService.getToken(query.token_address, true);
      if (token) {
        queryBuilder.andWhere('transactions.sale_address = :sale_address', {
          sale_address: token.sale_address,
        });
      }
    }

    return queryBuilder.getRawMany();
  }

  @ApiQuery({ name: 'token_sale_addresses', type: 'array', required: false })
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
  async totalUniqueUsers(
    @Query('token_sale_addresses') token_sale_addresses?: string[],
  ): Promise<TotalUniqueUsersResultDto> {
    if (token_sale_addresses && !Array.isArray(token_sale_addresses)) {
      token_sale_addresses = [token_sale_addresses];
    }
    if (token_sale_addresses?.length > MAX_TOKEN_SALE_ADDRESSES) {
      throw new BadRequestException(
        `Too many token_sale_addresses: max ${MAX_TOKEN_SALE_ADDRESSES} per request (got ${token_sale_addresses.length})`,
      );
    }
    // Count all unique users across the entire system
    const queryBuilder =
      this.transactionsRepository.createQueryBuilder('transactions');

    if (token_sale_addresses?.length) {
      const tokens = await this.tokensRepository.find({
        where: {
          sale_address: In(token_sale_addresses),
        },
      });
      const uniqueTokenSaleAddresses = tokens.map((t) => t.sale_address);
      // An empty list would expand to `IN ()`, which Postgres rejects.
      if (!uniqueTokenSaleAddresses.length) {
        return { total_users: 0 };
      }
      queryBuilder.andWhere(
        'transactions.sale_address IN (:...uniqueTokenSaleAddresses)',
        {
          uniqueTokenSaleAddresses,
        },
      );
    }

    const result = await queryBuilder
      .select('COUNT(DISTINCT transactions.address) as total_users')
      .getRawOne();
    return { total_users: parseInt(result.total_users) || 0 };
  }

  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiQuery({ name: 'end_date', type: 'string', required: false })
  @ApiQuery({ name: 'token_sale_addresses', type: 'array', required: false })
  @ApiOperation({
    operationId: 'listDailyMarketCapSum',
    description: 'Returns the sum of market caps for all tokens per day',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns the sum of market caps for all tokens per day',
    type: [DailyMarketCapSumDto],
  })
  @Get('daily-market-cap-sum')
  async listDailyMarketCapSum(
    @Query('start_date') start_date?: string,
    @Query('end_date') end_date?: string,
    @Query('token_sale_addresses') token_sale_addresses?: string[],
  ): Promise<DailyMarketCapSumDto[]> {
    if (token_sale_addresses && !Array.isArray(token_sale_addresses)) {
      token_sale_addresses = [token_sale_addresses];
    }

    const endDate = end_date ? moment(end_date) : moment();
    let startDate = start_date ? moment(start_date) : moment();

    const maxDays = 365;
    if (endDate.diff(startDate, 'days') > maxDays) {
      startDate = endDate.clone().subtract(maxDays, 'days');
    }

    const dates: string[] = [];
    const current = startDate.clone();
    while (current.isSameOrBefore(endDate, 'day')) {
      dates.push(current.format('YYYY-MM-DD'));
      current.add(1, 'day');
    }

    if (!dates.length) {
      return [];
    }
    return this.getCachedMarketCapSums(dates);
  }

  // Keyed by the days rather than the URL, which differs per time of day,
  // parameter order or unused parameter. The days are contiguous, so the first
  // and last identify the list.
  private getCachedMarketCapSums(
    dates: string[],
  ): Promise<DailyMarketCapSumDto[]> {
    const key = `${dates[0]}:${dates[dates.length - 1]}`;
    const cached = this.marketCapSums.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.sums;
    }

    const entry: MarketCapSumEntry = {
      sums: this.loadMarketCapSums(dates),
      expiresAt: Date.now() + MARKET_CAP_SUM_LOAD_DEADLINE_MS,
    };
    this.marketCapSums.set(key, entry);
    entry.sums.then(
      () => {
        entry.expiresAt = Date.now() + MARKET_CAP_SUM_TTL_MS;
      },
      () => {
        if (this.marketCapSums.get(key) === entry) {
          this.marketCapSums.delete(key);
        }
      },
    );
    return entry.sums;
  }

  private async loadMarketCapSums(
    dates: string[],
  ): Promise<DailyMarketCapSumDto[]> {
    let failure: { error: unknown } | undefined;
    // Each request queues at most 20 days at a time, so a short request
    // takes the next free slot instead of waiting behind a long request's
    // whole range.
    const results = await mapWithConcurrency(
      dates,
      MARKET_CAP_SUM_CONCURRENCY,
      (date) =>
        this.marketCapSumSlots(async () => {
          // The request has already failed, so don't start the remaining days.
          if (failure) {
            throw failure.error;
          }
          try {
            return await this.getMarketCapSum(date);
          } catch (error) {
            failure ??= { error };
            throw error;
          }
        }),
    );

    return results.sort((a, b) => a.date.localeCompare(b.date));
  }

  private async getMarketCapSum(date: string): Promise<DailyMarketCapSumDto> {
    const endOfDay = moment(date).endOf('day').toDate();

    const [result] = await this.transactionsRepository.query(
      `SELECT COALESCE(SUM(cap.market_cap), 0) AS total
       FROM (
         SELECT DISTINCT ON (sale_address)
           CAST(NULLIF(market_cap->>'ae', 'NaN') AS decimal) AS market_cap
         FROM transactions
         WHERE market_cap->>'ae' IS NOT NULL
           AND created_at <= $1
         ORDER BY sale_address, created_at DESC
       ) cap`,
      [endOfDay],
    );

    return {
      date,
      sum: parseFloat(result.total) || 0,
    } as any;
  }
}

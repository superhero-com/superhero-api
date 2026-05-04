import { TX_FUNCTIONS } from '@/configs';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { BigNumber } from 'bignumber.js';
import moment from 'moment';
import { LessThan, Repository } from 'typeorm';
import { Analytic } from '../entities/analytic.entity';
import { Token } from '@/tokens/entities/token.entity';

@Injectable()
export class CacheDailyAnalyticsDataService {
  fixingTokens = false;
  private readonly logger = new Logger(CacheDailyAnalyticsDataService.name);

  constructor(
    @InjectRepository(Analytic)
    private analyticsRepository: Repository<Analytic>,

    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,

    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,
  ) {
    //
  }

  onModuleInit() {
    setTimeout(() => this.pullDailyAnalyticsData(), 20_000);
  }

  isPullingDailyAnalyticsData = false;
  @Cron(CronExpression.EVERY_HOUR)
  async pullDailyAnalyticsData() {
    if (this.isPullingDailyAnalyticsData) {
      return;
    }
    this.isPullingDailyAnalyticsData = true;
    /**
     * decide start date:
     * - if no analytics
     */
    const latestAnalytic = await this.analyticsRepository.findOne({
      where: {},
      order: {
        date: 'DESC',
      },
    });

    let startDate = latestAnalytic?.date;

    if (!startDate) {
      // find first transaction date
      const firstTransaction = await this.transactionsRepository.findOne({
        where: {},
        order: {
          created_at: 'ASC',
        },
      });
      startDate = firstTransaction?.created_at;
    } else {
      startDate = moment().subtract(7, 'day').toDate();
    }

    const endDate = moment().add(1, 'day').toDate();

    await this.pullAnalyticsDataByDateRange(startDate, endDate);

    this.isPullingDailyAnalyticsData = false;
  }

  async pullAnalyticsDataByDateRange(startDate: Date, endDate: Date) {
    const dateRange = [];
    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      dateRange.push(new Date(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }

    for (const date of dateRange) {
      try {
        await this.pullAnalyticsData(date);
      } catch (error: any) {
        this.logger.error(
          `Error pulling analytics data for date ${date}`,
          error,
          error.stack,
        );
      }
    }
  }
  async pullAnalyticsData(date: Date) {
    const startOfDay = moment(date).startOf('day').toDate();
    const endOfDay = moment(date).endOf('day').toDate();
    const analyticsData = await this.getDateAnalytics(startOfDay, endOfDay);
    // delete the data if it exists
    await this.analyticsRepository.delete({
      date: startOfDay,
    });
    // console.log('analyticsData', analyticsData);
    // update or insert
    const analytic = await this.analyticsRepository.insert(analyticsData);
    return analytic;
  }

  async getDateAnalytics(startOfDay: Date, endOfDay: Date, address?: string) {
    const params: any[] = [startOfDay, endOfDay, TX_FUNCTIONS.create_community];
    let addressFilter = '';
    if (address) {
      params.push(address);
      addressFilter = ' AND address = $4';
    }

    const [txAgg] = await this.transactionsRepository.query(
      `SELECT
         COUNT(*)::int                              AS total_transactions,
         COUNT(DISTINCT address)::int               AS total_active_accounts,
         COALESCE(SUM(
           CAST(NULLIF(amount->>'ae', 'NaN') AS decimal)
         ), 0)                                      AS total_volume,
         COUNT(*) FILTER (
           WHERE tx_type = $3
         )::int                                     AS total_created_tokens
       FROM transactions
       WHERE created_at BETWEEN $1 AND $2${addressFilter}`,
      params,
    );

    const totalTokens = await this.tokensRepository.count({
      where: {
        created_at: LessThan(endOfDay),
        ...(address ? { creator_address: address } : {}),
      },
    });

    const totalMarketCap = await this.getMarketCapSum(endOfDay, address);

    return {
      date: moment(startOfDay).format('YYYY-MM-DD'),
      total_market_cap_sum: totalMarketCap,
      total_volume_sum: new BigNumber(txAgg.total_volume || 0),
      total_tokens: totalTokens,
      total_transactions: txAgg.total_transactions,
      total_created_tokens: txAgg.total_created_tokens,
      total_active_accounts: txAgg.total_active_accounts,
    };
  }

  /**
   * Per-day analytics computed live (no cache).
   * Mirrors the cached `analytics` row shape so the frontend can use it
   * interchangeably. Used when filtering by address.
   */
  async getDateRangeAnalyticsLive(
    startDate: Date,
    endDate: Date,
    address?: string,
  ) {
    const startOfRange = moment(startDate).startOf('day').toDate();
    const endOfRange = moment(endDate).endOf('day').toDate();

    const params: any[] = [
      startOfRange,
      endOfRange,
      TX_FUNCTIONS.create_community,
    ];
    let addressFilter = '';
    if (address) {
      params.push(address);
      addressFilter = ' AND address = $4';
    }

    const rows: Array<{
      day: Date;
      total_transactions: string | number;
      total_active_accounts: string | number;
      total_volume: string;
      total_created_tokens: string | number;
    }> = await this.transactionsRepository.query(
      `SELECT
         date_trunc('day', created_at) AS day,
         COUNT(*)::int                              AS total_transactions,
         COUNT(DISTINCT address)::int               AS total_active_accounts,
         COALESCE(SUM(
           CAST(NULLIF(amount->>'ae', 'NaN') AS decimal)
         ), 0)                                      AS total_volume,
         COUNT(*) FILTER (
           WHERE tx_type = $3
         )::int                                     AS total_created_tokens
       FROM transactions
       WHERE created_at BETWEEN $1 AND $2${addressFilter}
       GROUP BY day
       ORDER BY day ASC`,
      params,
    );

    if (rows.length === 0) {
      return [];
    }

    const enriched = await Promise.all(
      rows.map(async (row) => {
        const dayKey = moment(row.day).startOf('day').format('YYYY-MM-DD');
        const endOfThatDay = moment(dayKey).endOf('day').toDate();
        const [totalTokens, totalMarketCap] = await Promise.all([
          this.tokensRepository.count({
            where: {
              created_at: LessThan(endOfThatDay),
              ...(address ? { creator_address: address } : {}),
            },
          }),
          this.getMarketCapSum(endOfThatDay, address),
        ]);
        return {
          date: dayKey,
          total_market_cap_sum: totalMarketCap,
          total_volume_sum: new BigNumber(row.total_volume || 0),
          total_tokens: totalTokens,
          total_transactions: Number(row.total_transactions ?? 0),
          total_created_tokens: Number(row.total_created_tokens ?? 0),
          total_active_accounts: Number(row.total_active_accounts ?? 0),
        };
      }),
    );

    return enriched;
  }

  /**
   * Range-aggregated summary stats. Computes the TRUE distinct count of
   * wallet accounts active in the range (not a sum of per-day distincts,
   * which over-counts users active on multiple days).
   *
   * If `startDate`/`endDate` are omitted, the count is all-time.
   */
  async getRangeSummary(
    startDate: Date | undefined,
    endDate: Date | undefined,
    address?: string,
  ) {
    const params: any[] = [];
    const where: string[] = [];

    if (startDate && endDate) {
      params.push(
        moment(startDate).startOf('day').toDate(),
        moment(endDate).endOf('day').toDate(),
      );
      where.push(
        `created_at BETWEEN $${params.length - 1} AND $${params.length}`,
      );
    } else if (startDate) {
      params.push(moment(startDate).startOf('day').toDate());
      where.push(`created_at >= $${params.length}`);
    } else if (endDate) {
      params.push(moment(endDate).endOf('day').toDate());
      where.push(`created_at <= $${params.length}`);
    }

    if (address) {
      params.push(address);
      where.push(`address = $${params.length}`);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const [agg] = await this.transactionsRepository.query(
      `SELECT COUNT(DISTINCT address)::int AS total_unique_accounts
       FROM transactions
       ${whereClause}`,
      params,
    );

    return {
      total_unique_accounts: Number(agg?.total_unique_accounts ?? 0),
    };
  }

  private async getMarketCapSum(
    date: Date,
    address?: string,
  ): Promise<BigNumber> {
    if (address) {
      const [result] = await this.transactionsRepository.query(
        `SELECT COALESCE(SUM(cap.market_cap), 0) AS total
         FROM (
           SELECT DISTINCT ON (sale_address)
             CAST(NULLIF(market_cap->>'ae', 'NaN') AS decimal) AS market_cap
           FROM transactions
           WHERE market_cap->>'ae' IS NOT NULL
             AND created_at <= $1
             AND sale_address IN (
               SELECT sale_address FROM token WHERE creator_address = $2
             )
           ORDER BY sale_address, created_at DESC
         ) cap`,
        [date, address],
      );
      return new BigNumber(result.total || 0);
    }

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
      [date],
    );
    return new BigNumber(result.total || 0);
  }
}

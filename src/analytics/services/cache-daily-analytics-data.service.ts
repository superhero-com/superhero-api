import { TX_FUNCTIONS } from '@/configs';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { BigNumber } from 'bignumber.js';
import moment from 'moment';
import { Between, Repository } from 'typeorm';
import { Analytic } from '../entities/analytic.entity';

@Injectable()
export class CacheDailyAnalyticsDataService {
  fixingTokens = false;
  private readonly logger = new Logger(CacheDailyAnalyticsDataService.name);

  constructor(
    @InjectRepository(Analytic)
    private analyticsRepository: Repository<Analytic>,

    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
  ) {
    //
  }

  onModuleInit() {
    this.pullDailyAnalyticsData();
  }

  isPullingDailyAnalyticsData = false;
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
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
      startDate = moment().toDate();
    }

    const endDate = moment().subtract(1, 'day').toDate();

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
    const analyticsData = await this.getDateAnalytics(date);
    // console.log('analyticsData', analyticsData);
    // update or insert
    const analytic = await this.analyticsRepository.upsert(analyticsData, {
      conflictPaths: ['date'],
    });
    return analytic;
  }

  private async getDateAnalytics(date: Date) {
    const startOfDay = moment(date).startOf('day').toDate();
    const endOfDay = moment(date).endOf('day').toDate();

    const transactions = await this.transactionsRepository.find({
      where: {
        created_at: Between(startOfDay, endOfDay),
      },
    });

    // total unique users
    const totalUniqueUsers = new Set(
      transactions.map((transaction) => transaction.address),
    );

    const totalTransactions = transactions.length;
    const totalMarketCap = await this.getMarketCapSum(date);
    const totalVolume = transactions.reduce(
      (acc, transaction) => acc.plus(transaction.volume),
      new BigNumber(0),
    );
    const totalCreatedTokens = transactions.filter(
      (transaction) => transaction.tx_type === TX_FUNCTIONS.create_community,
    ).length;
    const totalActiveAccounts = totalUniqueUsers.size;

    return {
      date,
      total_market_cap_sum: totalMarketCap,
      total_volume_sum: totalVolume,
      total_tokens: totalTransactions,
      total_transactions: totalTransactions,
      total_created_tokens: totalCreatedTokens,
      total_active_accounts: totalActiveAccounts,
    };
  }

  private async getMarketCapSum(date: Date) {
    const $date = moment(date);
    const smartTransactionQuery = this.transactionsRepository
      .createQueryBuilder('transaction')
      .select(
        'DISTINCT ON (transaction.sale_address) transaction.sale_address',
        'sale_address',
      )
      .addSelect("transaction.market_cap->>'ae'", 'market_cap')
      .where("transaction.market_cap->>'ae' IS NOT NULL")
      .andWhere('transaction.created_at <= :start_date', {
        start_date: $date.toDate(),
      })
      .orderBy('transaction.sale_address')
      .addOrderBy('transaction.created_at', 'DESC');
    const smartTokens = await smartTransactionQuery.getRawMany();

    // Calculate total market cap sum
    return smartTokens.reduce((sum, token) => {
      const marketCap = parseFloat(token.market_cap);
      return sum + (isNaN(marketCap) ? 0 : marketCap);
    }, 0);
  }
}

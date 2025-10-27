import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import moment from 'moment';

import { Token } from '../entities/token.entity';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { TokenPerformance } from '../entities/token-performance.entity';
import { TokenPerformanceService } from './token-performance.service';
import {
  TOKEN_PERFORMANCE_CONFIG,
  UPDATE_TOKEN_PERFORMANCE_ENABLED,
} from '@/configs';

@Injectable()
export class UpdateTokenPerformanceService {
  private readonly logger = new Logger(UpdateTokenPerformanceService.name);

  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,

    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,

    @InjectRepository(TokenPerformance)
    private tokenPerformanceRepository: Repository<TokenPerformance>,

    private tokenPerformanceService: TokenPerformanceService,
  ) {}

  onModuleInit() {
    if (UPDATE_TOKEN_PERFORMANCE_ENABLED) {
      this.logger.log('Token Performance Update Service initialized');
      // Run initial updates
      this.updatePerformance24h();
      this.updatePerformance7d();
      this.updatePerformance30d();
      this.updateTokensWithoutCache();
    }
  }

  /**
   * Update 24h performance for tokens with transactions in the past 24 hours
   * Runs every 30 minutes
   */
  isUpdating24h = false;
  @Cron(CronExpression.EVERY_30_MINUTES)
  async updatePerformance24h() {
    if (this.isUpdating24h || !UPDATE_TOKEN_PERFORMANCE_ENABLED) {
      return;
    }

    this.isUpdating24h = true;
    const startTime = Date.now();

    try {
      this.logger.log('Starting 24h performance update...');

      // Get tokens with transactions in the past 24 hours
      const tokensWithRecentTx = await this.transactionsRepository
        .createQueryBuilder('transaction')
        .select('DISTINCT transaction.sale_address', 'sale_address')
        .where('transaction.created_at > :date', {
          date: moment().subtract(24, 'hours').toDate(),
        })
        .getRawMany();

      const saleAddresses = tokensWithRecentTx.map((row) => row.sale_address);

      if (saleAddresses.length === 0) {
        this.logger.log('No tokens with 24h transactions found');
        return;
      }

      // Get tokens that need updating (either stale or no cache)
      const tokens = await this.getTokensNeedingUpdate(
        saleAddresses,
        TOKEN_PERFORMANCE_CONFIG.STALE_THRESHOLD_24H,
        TOKEN_PERFORMANCE_CONFIG.MAX_TOKENS_PER_RUN_24H,
      );

      this.logger.log(
        `Updating 24h performance for ${tokens.length} tokens out of ${saleAddresses.length} with recent transactions`,
      );

      let successCount = 0;
      let errorCount = 0;

      for (const token of tokens) {
        try {
          await this.updateTokenPerformance(token, 'past_24h');
          successCount++;
        } catch (error: any) {
          errorCount++;
          this.logger.error(
            `Failed to update 24h performance for token ${token.sale_address}`,
            error.stack,
          );
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      this.logger.log(
        `24h performance update completed in ${duration}s. Success: ${successCount}, Errors: ${errorCount}`,
      );
    } catch (error: any) {
      this.logger.error('Failed to update 24h performance', error.stack);
    } finally {
      this.isUpdating24h = false;
    }
  }

  /**
   * Update 7d performance for tokens with transactions in the past 7 days
   * Runs every 2 hours
   */
  isUpdating7d = false;
  @Cron(CronExpression.EVERY_2_HOURS)
  async updatePerformance7d() {
    if (this.isUpdating7d || !UPDATE_TOKEN_PERFORMANCE_ENABLED) {
      return;
    }

    this.isUpdating7d = true;
    const startTime = Date.now();

    try {
      this.logger.log('Starting 7d performance update...');

      // Get tokens with transactions in the past 7 days
      const tokensWithRecentTx = await this.transactionsRepository
        .createQueryBuilder('transaction')
        .select('DISTINCT transaction.sale_address', 'sale_address')
        .where('transaction.created_at > :date', {
          date: moment().subtract(7, 'days').toDate(),
        })
        .getRawMany();

      const saleAddresses = tokensWithRecentTx.map((row) => row.sale_address);

      if (saleAddresses.length === 0) {
        this.logger.log('No tokens with 7d transactions found');
        return;
      }

      const tokens = await this.getTokensNeedingUpdate(
        saleAddresses,
        TOKEN_PERFORMANCE_CONFIG.STALE_THRESHOLD_7D,
        TOKEN_PERFORMANCE_CONFIG.MAX_TOKENS_PER_RUN_7D,
      );

      this.logger.log(
        `Updating 7d performance for ${tokens.length} tokens out of ${saleAddresses.length} with recent transactions`,
      );

      let successCount = 0;
      let errorCount = 0;

      for (const token of tokens) {
        try {
          await this.updateTokenPerformance(token, 'past_7d');
          successCount++;
        } catch (error: any) {
          errorCount++;
          this.logger.error(
            `Failed to update 7d performance for token ${token.sale_address}`,
            error.stack,
          );
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      this.logger.log(
        `7d performance update completed in ${duration}s. Success: ${successCount}, Errors: ${errorCount}`,
      );
    } catch (error: any) {
      this.logger.error('Failed to update 7d performance', error.stack);
    } finally {
      this.isUpdating7d = false;
    }
  }

  /**
   * Update 30d performance for tokens with transactions in the past 30 days
   * Runs every 6 hours
   */
  isUpdating30d = false;
  @Cron(CronExpression.EVERY_6_HOURS)
  async updatePerformance30d() {
    if (this.isUpdating30d || !UPDATE_TOKEN_PERFORMANCE_ENABLED) {
      return;
    }

    this.isUpdating30d = true;
    const startTime = Date.now();

    try {
      this.logger.log('Starting 30d performance update...');

      // Get tokens with transactions in the past 30 days
      const tokensWithRecentTx = await this.transactionsRepository
        .createQueryBuilder('transaction')
        .select('DISTINCT transaction.sale_address', 'sale_address')
        .where('transaction.created_at > :date', {
          date: moment().subtract(30, 'days').toDate(),
        })
        .getRawMany();

      const saleAddresses = tokensWithRecentTx.map((row) => row.sale_address);

      if (saleAddresses.length === 0) {
        this.logger.log('No tokens with 30d transactions found');
        return;
      }

      const tokens = await this.getTokensNeedingUpdate(
        saleAddresses,
        TOKEN_PERFORMANCE_CONFIG.STALE_THRESHOLD_30D,
        TOKEN_PERFORMANCE_CONFIG.MAX_TOKENS_PER_RUN_30D,
      );

      this.logger.log(
        `Updating 30d performance for ${tokens.length} tokens out of ${saleAddresses.length} with recent transactions`,
      );

      let successCount = 0;
      let errorCount = 0;

      for (const token of tokens) {
        try {
          await this.updateTokenPerformance(token, 'past_30d');
          successCount++;
        } catch (error: any) {
          errorCount++;
          this.logger.error(
            `Failed to update 30d performance for token ${token.sale_address}`,
            error.stack,
          );
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      this.logger.log(
        `30d performance update completed in ${duration}s. Success: ${successCount}, Errors: ${errorCount}`,
      );
    } catch (error: any) {
      this.logger.error('Failed to update 30d performance', error.stack);
    } finally {
      this.isUpdating30d = false;
    }
  }

  /**
   * Update tokens that don't have cached performance data yet
   * Runs every hour
   */
  isUpdatingWithoutCache = false;
  @Cron(CronExpression.EVERY_HOUR)
  async updateTokensWithoutCache() {
    if (this.isUpdatingWithoutCache || !UPDATE_TOKEN_PERFORMANCE_ENABLED) {
      return;
    }

    this.isUpdatingWithoutCache = true;
    const startTime = Date.now();

    try {
      this.logger.log(
        'Starting update for tokens without cached performance...',
      );

      // Get all token sale addresses
      const allTokens = await this.tokensRepository
        .createQueryBuilder('token')
        .select('token.sale_address')
        .where('token.unlisted = :unlisted', { unlisted: false })
        .getMany();

      const allSaleAddresses = allTokens.map((t) => t.sale_address);

      // Get tokens that already have performance cache
      const cachedPerformance = await this.tokenPerformanceRepository
        .createQueryBuilder('performance')
        .select('performance.sale_address')
        .getMany();

      const cachedSaleAddresses = new Set(
        cachedPerformance.map((p) => p.sale_address),
      );

      // Find tokens without cache
      const tokensWithoutCache = allSaleAddresses.filter(
        (addr) => !cachedSaleAddresses.has(addr),
      );

      if (tokensWithoutCache.length === 0) {
        this.logger.log('All tokens have cached performance data');
        return;
      }

      this.logger.log(
        `Found ${tokensWithoutCache.length} tokens without cached performance`,
      );

      // Limit to max per run
      const addressesToUpdate = tokensWithoutCache.slice(
        0,
        TOKEN_PERFORMANCE_CONFIG.MAX_TOKENS_WITHOUT_CACHE,
      );

      const tokens = await this.tokensRepository.find({
        where: {
          sale_address: In(addressesToUpdate),
        },
      });

      this.logger.log(
        `Updating performance for ${tokens.length} tokens without cache`,
      );

      let successCount = 0;
      let errorCount = 0;

      for (const token of tokens) {
        try {
          await this.updateTokenPerformance(token, 'all');
          successCount++;
        } catch (error: any) {
          errorCount++;
          this.logger.error(
            `Failed to update performance for uncached token ${token.sale_address}`,
            error.stack,
          );
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      this.logger.log(
        `Uncached tokens update completed in ${duration}s. Success: ${successCount}, Errors: ${errorCount}`,
      );
    } catch (error: any) {
      this.logger.error('Failed to update tokens without cache', error.stack);
    } finally {
      this.isUpdatingWithoutCache = false;
    }
  }

  /**
   * Get tokens that need updating based on staleness threshold
   */
  private async getTokensNeedingUpdate(
    saleAddresses: string[],
    staleThresholdHours: number,
    maxTokens: number,
  ): Promise<Token[]> {
    if (saleAddresses.length === 0) {
      return [];
    }

    const staleDate = moment().subtract(staleThresholdHours, 'hours').toDate();

    // Get all performance data for these tokens
    const allPerformanceData = await this.tokenPerformanceRepository
      .createQueryBuilder('performance')
      .where('performance.sale_address IN (:...addresses)', {
        addresses: saleAddresses,
      })
      .select(['performance.sale_address', 'performance.updated_at'])
      .getMany();

    const performanceMap = new Map(
      allPerformanceData.map((p) => [p.sale_address, p.updated_at]),
    );

    // Find addresses that need updating (stale or missing)
    const addressesToUpdate = saleAddresses.filter((addr) => {
      const updatedAt = performanceMap.get(addr);
      // Include if no performance data OR if data is stale
      return !updatedAt || updatedAt < staleDate;
    });

    if (addressesToUpdate.length === 0) {
      return [];
    }

    // Limit to max tokens
    const limitedAddresses = addressesToUpdate.slice(0, maxTokens);

    // Get the actual tokens
    return this.tokensRepository.find({
      where: {
        sale_address: In(limitedAddresses),
        unlisted: false,
      },
      order: {
        market_cap: 'DESC',
      },
    });
  }

  /**
   * Update performance for a specific token and period
   */
  private async updateTokenPerformance(
    token: Token,
    period: 'past_24h' | 'past_7d' | 'past_30d' | 'all',
  ): Promise<void> {
    // Get existing performance data
    const existingPerformance =
      await this.tokenPerformanceService.getPerformanceData(token.sale_address);

    const performanceData: any = {
      past_24h: existingPerformance?.past_24h || null,
      past_7d: existingPerformance?.past_7d || null,
      past_30d: existingPerformance?.past_30d || null,
      all_time: existingPerformance?.all_time || null,
    };

    // Calculate performance for the specified period(s)
    if (period === 'all' || period === 'past_24h') {
      const past_24h = await this.tokenPerformanceService.getTokenPriceMovement(
        token,
        moment().subtract(24, 'hours'),
      );
      performanceData.past_24h = { ...past_24h, last_updated: new Date() };
    }

    if (period === 'all' || period === 'past_7d') {
      const past_7d = await this.tokenPerformanceService.getTokenPriceMovement(
        token,
        moment().subtract(7, 'days'),
      );
      performanceData.past_7d = { ...past_7d, last_updated: new Date() };
    }

    if (period === 'all' || period === 'past_30d') {
      const past_30d = await this.tokenPerformanceService.getTokenPriceMovement(
        token,
        moment().subtract(30, 'days'),
      );
      performanceData.past_30d = { ...past_30d, last_updated: new Date() };
    }

    // Always update all_time when updating any period
    const all_time = await this.tokenPerformanceService.getTokenPriceMovement(
      token,
      moment(token.created_at).subtract(30, 'days'),
    );
    performanceData.all_time = { ...all_time, last_updated: new Date() };

    // Store the updated performance data
    await this.tokenPerformanceService.storePerformanceData(
      token,
      performanceData,
    );
  }
}

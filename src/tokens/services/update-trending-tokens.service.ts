import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';

import { Token } from '../entities/token.entity';
import { TokensService } from '../tokens.service';
import { Transaction } from '@/transactions/entities/transaction.entity';
import moment from 'moment';
import { CronExpression } from '@nestjs/schedule';
import { Cron } from '@nestjs/schedule';
import { TRENDING_SCORE_CONFIG } from '@/configs';

@Injectable()
export class UpdateTrendingTokensService {
  private readonly logger = new Logger(UpdateTrendingTokensService.name);
  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,

    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,

    private tokensService: TokensService,
  ) {
    //
  }

  onModuleInit() {
    this.updateTrendingTokens();
    this.fixOldTrendingTokens();
  }

  isUpdatingTrendingTokens = false;
  @Cron(CronExpression.EVERY_10_MINUTES)
  async updateTrendingTokens() {
    if (this.isUpdatingTrendingTokens) {
      return;
    }
    this.isUpdatingTrendingTokens = true;
    // query only tokens that has some transactions in the last 48 hours
    const latestUniqueTransactions = await this.transactionsRepository
      .createQueryBuilder('transaction')
      .select('DISTINCT transaction.sale_address', 'sale_address')
      .where('transaction.created_at > :date', {
        date: moment()
          .subtract(TRENDING_SCORE_CONFIG.TIME_WINDOW_HOURS, 'hours')
          .toDate(),
      })
      .getRawMany();

    // Extract sale_addresses from the result
    const uniqueSaleAddresses = latestUniqueTransactions.map(
      (row) => row.sale_address,
    );

    const tokens = await this.tokensRepository.find({
      where: {
        unlisted: false,
        sale_address: In(uniqueSaleAddresses),
      },
      order: {
        market_cap: 'DESC',
      },
      take: 1000,
    });

    for (const token of tokens) {
      try {
        await this.tokensService.updateTokenTrendingScore(token);
      } catch (error: any) {
        this.logger.error(
          `Failed to update trending score for token ${token.sale_address}`,
          error,
          error.stack,
        );
      }
    }
    this.isUpdatingTrendingTokens = false;
  }

  isFixingOldTrendingTokens = false;
  @Cron(CronExpression.EVERY_10_MINUTES)
  async fixOldTrendingTokens() {
    if (this.isFixingOldTrendingTokens) {
      return;
    }
    this.isFixingOldTrendingTokens = true;
    const tokens = await this.tokensRepository.find({
      where: {
        trending_score_update_at: LessThan(
          moment()
            .subtract(TRENDING_SCORE_CONFIG.TIME_WINDOW_HOURS, 'hours')
            .toDate(),
        ),
      },
      order: {
        trending_score_update_at: 'ASC',
      },
      take: 100,
    });

    for (const token of tokens) {
      try {
        await this.tokensService.updateTokenTrendingScore(token);
      } catch (error: any) {
        this.logger.error(
          `Failed to update trending score for token ${token.sale_address}`,
          error,
          error.stack,
        );
      }
    }
    this.isFixingOldTrendingTokens = false;
  }
}

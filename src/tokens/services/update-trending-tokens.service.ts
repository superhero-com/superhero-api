import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';

import { Token } from '../entities/token.entity';
import { TokensService } from '../tokens.service';
import { Transaction } from '@/transactions/entities/transaction.entity';
import moment from 'moment';
import { Cron } from '@nestjs/schedule';
import {
  TRENDING_SCORE_CONFIG,
  UPDATE_TRENDING_TOKENS_ENABLED,
} from '@/configs';
import { buildNormalizedTokenMentionSelectSql } from '@/social/utils/token-mentions-sql.util';

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

  async onModuleInit() {
    await this.runStartupTaskSafely(
      'fix NaN trending scores',
      this.fixAllNanTrendingTokens.bind(this),
    );
    await this.runStartupTaskSafely(
      'refresh active trending tokens',
      this.updateTrendingTokens.bind(this),
    );
    await this.runStartupTaskSafely(
      'backfill stale trending tokens',
      this.fixOldTrendingTokens.bind(this),
    );
  }

  private async runStartupTaskSafely(
    taskName: string,
    task: () => Promise<void>,
  ): Promise<void> {
    try {
      await task();
    } catch (error) {
      this.logger.error(
        `Failed to ${taskName} during startup`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  isUpdatingTrendingTokens = false;
  @Cron(TRENDING_SCORE_CONFIG.REFRESH_CRON)
  async updateTrendingTokens() {
    if (this.isUpdatingTrendingTokens || !UPDATE_TRENDING_TOKENS_ENABLED) {
      return;
    }
    this.isUpdatingTrendingTokens = true;
    try {
      const recentSince = moment()
        .subtract(TRENDING_SCORE_CONFIG.ACTIVITY_LOOKBACK_MINUTES, 'minutes')
        .toDate();
      const recentSinceDate = moment(recentSince).format('YYYY-MM-DD');

      const [
        latestUniqueTransactions,
        recentPostSymbols,
        recentTipSymbols,
        recentReadSymbols,
      ] = await Promise.all([
        this.transactionsRepository
          .createQueryBuilder('transaction')
          .select('DISTINCT transaction.sale_address', 'sale_address')
          .where('transaction.created_at > :date', {
            date: recentSince,
          })
          .getRawMany<{ sale_address: string }>(),
        this.tokensRepository.query(
          `
            SELECT DISTINCT symbol
            FROM (
              SELECT mention.symbol
              FROM posts post
              CROSS JOIN LATERAL (
                ${buildNormalizedTokenMentionSelectSql('post')}
              ) mention
              WHERE post.is_hidden = false
                AND post.created_at >= $1
              UNION
              SELECT mention.symbol
              FROM posts post
              INNER JOIN posts parent ON post.post_id = parent.id
              CROSS JOIN LATERAL (
                ${buildNormalizedTokenMentionSelectSql('parent')}
              ) mention
              WHERE post.is_hidden = false
                AND post.created_at >= $1
            ) symbols
          `,
          [recentSince],
        ),
        this.tokensRepository.query(
          `
            SELECT DISTINCT symbol
            FROM (
              SELECT mention.symbol
              FROM tips tip
              INNER JOIN posts post ON post.id = tip.post_id
              CROSS JOIN LATERAL (
                ${buildNormalizedTokenMentionSelectSql('post')}
              ) mention
              WHERE tip.created_at >= $1
                AND tip.sender_address != post.sender_address
              UNION
              SELECT mention.symbol
              FROM tips tip
              INNER JOIN posts post ON post.id = tip.post_id
              INNER JOIN posts parent ON post.post_id = parent.id
              CROSS JOIN LATERAL (
                ${buildNormalizedTokenMentionSelectSql('parent')}
              ) mention
              WHERE tip.created_at >= $1
                AND tip.sender_address != post.sender_address
            ) symbols
          `,
          [recentSince],
        ),
        this.tokensRepository.query(
          `
            SELECT DISTINCT symbol
            FROM (
              SELECT mention.symbol
              FROM post_reads_daily reads
              INNER JOIN posts post ON post.id = reads.post_id
              CROSS JOIN LATERAL (
                ${buildNormalizedTokenMentionSelectSql('post')}
              ) mention
              WHERE reads.date >= $1::date
              UNION
              SELECT mention.symbol
              FROM post_reads_daily reads
              INNER JOIN posts post ON post.id = reads.post_id
              INNER JOIN posts parent ON post.post_id = parent.id
              CROSS JOIN LATERAL (
                ${buildNormalizedTokenMentionSelectSql('parent')}
              ) mention
              WHERE reads.date >= $1::date
            ) symbols
          `,
          [recentSinceDate],
        ),
      ]);

      const uniqueSaleAddresses = new Set<string>(
        latestUniqueTransactions.map((row) => row.sale_address),
      );
      const activeSymbols = [
        ...new Set(
          [...recentPostSymbols, ...recentTipSymbols, ...recentReadSymbols]
            .map((row: { symbol: string }) => (row.symbol || '').toUpperCase())
            .filter(Boolean),
        ),
      ];

      if (activeSymbols.length) {
        const symbolTokens = await this.tokensRepository
          .createQueryBuilder('token')
          .select('token.sale_address', 'sale_address')
          .where('token.unlisted = false')
          .andWhere('UPPER(token.symbol) IN (:...symbols)', {
            symbols: activeSymbols,
          })
          .getRawMany<{ sale_address: string }>();

        symbolTokens.forEach((row) =>
          uniqueSaleAddresses.add(row.sale_address),
        );
      }

      if (!uniqueSaleAddresses.size) {
        return;
      }

      const tokens = await this.tokensRepository
        .createQueryBuilder('token')
        .where('token.unlisted = false')
        .andWhere('token.sale_address IN (:...saleAddresses)', {
          saleAddresses: [...uniqueSaleAddresses],
        })
        .orderBy('token.trending_score_update_at', 'ASC', 'NULLS FIRST')
        .addOrderBy('token.created_at', 'DESC')
        .limit(TRENDING_SCORE_CONFIG.MAX_ACTIVE_BATCH)
        .getMany();

      await this.tokensService.updateMultipleTokensTrendingScores(tokens);
    } finally {
      this.isUpdatingTrendingTokens = false;
    }
  }

  isFixingOldTrendingTokens = false;
  @Cron(TRENDING_SCORE_CONFIG.REFRESH_CRON)
  async fixOldTrendingTokens() {
    if (this.isFixingOldTrendingTokens || !UPDATE_TRENDING_TOKENS_ENABLED) {
      return;
    }
    this.isFixingOldTrendingTokens = true;
    try {
      const staleBefore = moment()
        .subtract(TRENDING_SCORE_CONFIG.STALE_AFTER_MINUTES, 'minutes')
        .toDate();
      const tokens = await this.tokensRepository
        .createQueryBuilder('token')
        .where('token.unlisted = false')
        .andWhere(
          new Brackets((queryBuilder) => {
            queryBuilder
              .where('token.trending_score_update_at IS NULL')
              .orWhere('token.trending_score_update_at < :staleBefore', {
                staleBefore,
              });
          }),
        )
        .orderBy('token.trending_score_update_at', 'ASC', 'NULLS FIRST')
        .limit(TRENDING_SCORE_CONFIG.MAX_STALE_BATCH)
        .getMany();

      await this.tokensService.updateMultipleTokensTrendingScores(tokens);
    } finally {
      this.isFixingOldTrendingTokens = false;
    }
  }

  async fixAllNanTrendingTokens() {
    await this.tokensRepository.query(`
      UPDATE token
      SET trending_score = 0
      WHERE trending_score::text = 'NaN'
    `);
  }
}

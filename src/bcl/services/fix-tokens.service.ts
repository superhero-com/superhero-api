import { Token } from '@/tokens/entities/token.entity';
import { TokensService } from '@/tokens/tokens.service';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

@Injectable()
export class FixTokensService {
  fixingTokens = false;
  private readonly logger = new Logger(FixTokensService.name);

  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,

    private readonly tokensService: TokensService,
  ) {
    //
  }

  onModuleInit() {
    this.fixTokensWithNoPrice();
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async fixTokensAddresses() {
    if (this.fixingTokens) {
      return;
    }
    this.fixingTokens = true;

    // find all tokens where address is null
    const tokens = await this.tokensRepository.find({
      where: {
        address: IsNull(),
      },
      order: {
        total_supply: 'DESC',
      },
      take: 100,
    });
    for (const token of tokens) {
      try {
        await this.tokensService.getTokenAex9Address(token);
      } catch (error: any) {
        this.logger.error(
          `FixTokensService: ${token.sale_address} - ${error.message}`,
          error.stack,
        );
        await this.tokensRepository.delete(token.sale_address);
      }
    }
    this.fixingTokens = false;
  }

  isFixingTokensWithNoPrice = false;
  @Cron(CronExpression.EVERY_5_MINUTES)
  async fixTokensWithNoPrice() {
    if (this.isFixingTokensWithNoPrice) {
      return;
    }
    this.isFixingTokensWithNoPrice = true;
    const tokens = await this.tokensRepository
      .createQueryBuilder('token')
      .where('token.price = :price', { price: '0' })
      .orderBy('token.created_at', 'DESC')
      .take(100)
      .getMany();
    for (const token of tokens) {
      await this.tokensService.syncTokenPrice(token);
    }
    this.isFixingTokensWithNoPrice = false;
  }

  isFixingTokensWithNoCollection = false;
  /**
   * Backfill `token.collection` for legacy rows created before it was set at
   * creation time. The value is sourced from each token's own `create_community`
   * tx (`txs.raw.arguments[0]`), which always exists for an indexed token.
   *
   * Pure local SQL in short 1000-row statements (no long locks / bloat), bounded
   * per tick so the cron stays short. Idempotent and self-draining: once every
   * row is filled it finds nothing and no-ops (and the create paths now set
   * collection up front, so no new NULLs appear).
   *
   * On large tables, speed up the `collection IS NULL` scan with a partial index:
   *   CREATE INDEX CONCURRENTLY IF NOT EXISTS token_create_tx_hash_null_collection_idx
   *     ON token (create_tx_hash) WHERE collection IS NULL;
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async fixTokensWithNoCollection() {
    if (this.isFixingTokensWithNoCollection) {
      return;
    }
    this.isFixingTokensWithNoCollection = true;

    const batchSize = 1000;
    const maxRowsPerRun = 10000; // bound cron duration on large backlogs
    let totalUpdated = 0;
    try {
      let affected = 0;
      do {
        const rows = await this.tokensRepository.query(
          `
            WITH batch AS (
              SELECT t.sale_address,
                     (x.raw->'arguments'->0->>'value') AS collection
              FROM token t
              JOIN txs x ON x.hash = t.create_tx_hash
              WHERE t.collection IS NULL
                AND x.function = 'create_community'
                AND (x.raw->'arguments'->0->>'value') IS NOT NULL
              LIMIT $1
            )
            UPDATE token t
            SET collection = batch.collection
            FROM batch
            WHERE t.sale_address = batch.sale_address
            RETURNING t.sale_address
          `,
          [batchSize],
        );
        affected = Array.isArray(rows) ? rows.length : 0;
        totalUpdated += affected;
      } while (affected === batchSize && totalUpdated < maxRowsPerRun);

      if (totalUpdated) {
        this.logger.log(
          `FixTokensService: backfilled collection for ${totalUpdated} tokens`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `FixTokensService.fixTokensWithNoCollection: ${error.message}`,
        error.stack,
      );
    } finally {
      this.isFixingTokensWithNoCollection = false;
    }
  }
}

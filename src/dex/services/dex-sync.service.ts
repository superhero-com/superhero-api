import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { DEX_CONTRACTS } from '../config/dex-contracts.config';
import { DexToken } from '../entities/dex-token.entity';
import { Pair } from '../entities/pair.entity';
import { PairService } from './pair.service';
import BigNumber from 'bignumber.js';
import { DexTokenService } from './dex-token.service';
import { PairSummaryService } from './pair-summary.service';
import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { DexTokenSummaryService } from './dex-token-summary.service';

@Injectable()
export class DexSyncService {
  private readonly logger = new Logger(DexSyncService.name);
  // Distinct from DexSchemaBootstrapService's advisory lock (4019283746).
  private static readonly PRICE_SYNC_LOCK_KEY = 4019283747;
  private priceSyncRunning = false;
  constructor(
    @InjectRepository(DexToken)
    private readonly dexTokenRepository: Repository<DexToken>,
    @InjectRepository(Pair)
    private readonly dexPairRepository: Repository<Pair>,
    @InjectDataSource()
    private readonly dataSource: DataSource,

    private pairService: PairService,
    private dexTokenService: DexTokenService,
    private pairSummaryService: PairSummaryService,
    private aePricingService: AePricingService,
    private tokenSummaryService: DexTokenSummaryService,
  ) {
    //
  }

  /**
   * Periodically recompute derived DEX data — token prices, token summaries and
   * pair summaries — from the live pairs/transactions, so the stored values
   * self-heal instead of needing a manual `sync-dex.js` run after every deploy.
   *
   * Guards: an in-process flag prevents overlap if a run exceeds the interval; a
   * non-blocking Postgres advisory lock ensures only ONE container recomputes at
   * a time; and the whole job is skipped when live sync is disabled (the backfill
   * scripts run with DISABLE_MDW_SYNC=true and drive the sync themselves).
   */
  @Cron(process.env.DEX_PRICE_SYNC_CRON || CronExpression.EVERY_10_MINUTES)
  async scheduledPriceSync(): Promise<void> {
    if (process.env.DISABLE_MDW_SYNC === 'true') {
      return;
    }
    if (this.priceSyncRunning) {
      this.logger.warn(
        'Scheduled DEX price sync still running; skipping this tick',
      );
      return;
    }
    this.priceSyncRunning = true;
    const queryRunner = this.dataSource.createQueryRunner();
    let locked = false;
    try {
      await queryRunner.connect();
      const lockRows = await queryRunner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [DexSyncService.PRICE_SYNC_LOCK_KEY],
      );
      locked = !!lockRows?.[0]?.locked;
      if (!locked) {
        this.logger.debug(
          'Another instance holds the DEX price-sync lock; skipping this tick',
        );
        return;
      }
      await this.syncTokenPrices();
      this.logger.debug('Scheduled DEX price sync completed');
    } catch (error) {
      this.logger.error('Scheduled DEX price sync failed', error as Error);
    } finally {
      if (locked) {
        try {
          await queryRunner.query('SELECT pg_advisory_unlock($1)', [
            DexSyncService.PRICE_SYNC_LOCK_KEY,
          ]);
        } catch (unlockError) {
          this.logger.error(
            'Failed to release DEX price-sync advisory lock',
            unlockError as Error,
          );
        }
      }
      await queryRunner.release();
      this.priceSyncRunning = false;
    }
  }

  private static readonly SYNC_BATCH_SIZE = 100;

  /**
   * Prices are computed from the reserves stored on `pairs`, which the indexer
   * only reads when it first sees a pair, so re-read them before pricing.
   */
  private async refreshPairsFromChain(): Promise<void> {
    let factoryPairs: Set<string>;
    try {
      factoryPairs = await this.pairService.getFactoryPairAddresses();
    } catch (error) {
      this.logger.error(
        'Failed to load factory pairs; pricing from stored reserves',
        error as Error,
      );
      return;
    }

    const pairs = await this.dexPairRepository.find({
      relations: { token0: true, token1: true },
    });
    for (const pair of pairs) {
      if (!factoryPairs.has(pair.address)) {
        // Older indexer versions stored any contract that emitted events named
        // like a pair's. Reading such a contract would return whatever it likes.
        this.logger.error(`Pair ${pair.address} is not a factory pair`);
        continue;
      }
      try {
        await this.pairService.syncPairFromChain(pair);
      } catch (error) {
        this.logger.error(
          `Failed to refresh pair ${pair.address} from chain`,
          error as Error,
        );
      }
    }
  }

  async syncTokenPrices() {
    await this.refreshPairsFromChain();

    const batchSize = DexSyncService.SYNC_BATCH_SIZE;
    // The cached list may predate the refresh above.
    const allPairs = await this.dexTokenService.getAllPairsWithTokens({
      fresh: true,
    });
    const priceCache = new Map<string, Promise<string | null>>();

    let tokenSkip = 0;
    while (true) {
      const tokens = await this.dexTokenRepository.find({
        order: { address: 'ASC' },
        take: batchSize,
        skip: tokenSkip,
      });
      if (!tokens.length) break;

      for (const token of tokens) {
        try {
          const priceAnalysis =
            await this.dexTokenService.getTokenPriceWithLiquidityAnalysis(
              token.address,
              DEX_CONTRACTS.wae,
              { allPairs },
            );

          // Use the deepest-liquidity path price (matches the chart and the
          // /price endpoint), NOT the median — the median is poisoned by
          // dust/dead pools and multi-hop outliers.
          if (!priceAnalysis) {
            continue;
          }

          // A null price means the token has no AE-denominated price (no liquid
          // path to WAE). Persist null so the stored/listed price clears instead
          // of keeping a stale value; the summary (volume) is still recomputed.
          const price_data = priceAnalysis.price
            ? await this.aePricingService.getPriceData(
                new BigNumber(priceAnalysis.price),
              )
            : null;
          await this.dexTokenRepository.update(token.address, {
            price: price_data,
          });
          await this.tokenSummaryService.createOrUpdateSummary(token.address, {
            allPairs,
            priceCache,
          });
        } catch (error) {
          this.logger.error(`Error syncing token ${token.address}:`, error);
          continue;
        }
      }
      tokenSkip += batchSize;
    }

    let pairSkip = 0;
    while (true) {
      const pairs = await this.dexPairRepository
        .createQueryBuilder('pair')
        .leftJoinAndSelect('pair.token0', 'token0')
        .leftJoinAndSelect('pair.token1', 'token1')
        .orderBy('pair.address', 'ASC')
        .take(batchSize)
        .skip(pairSkip)
        .getMany();
      if (!pairs.length) break;

      for (const pair of pairs) {
        await this.pairSummaryService.createOrUpdateSummary(pair);
      }
      pairSkip += batchSize;
    }
  }
}

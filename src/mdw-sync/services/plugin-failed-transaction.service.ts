import { Plugin, PluginBatchFailure } from '@/plugins/plugin.interface';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { PluginFailedTransaction } from '../entities/plugin-failed-transaction.entity';
import { SyncState } from '../entities/sync-state.entity';
import { Tx } from '../entities/tx.entity';
import { SyncDirectionEnum } from '../types/sync-direction';
import { PluginRegistryService } from './plugin-registry.service';

export const MAX_RETRY_ATTEMPTS = 10;
const RETRY_BASE_DELAY_MS = 10 * 60 * 1000;
const RETRY_MAX_DELAY_MS = 24 * 60 * 60 * 1000;
const RETRY_BATCH_SIZE = 100;
const RETRY_MAX_ROWS_PER_PLUGIN_RUN = 1000;
const RETRY_TIP_MARGIN_BLOCKS = 5;
// Each run reads `now` only once it holds the lock, so a row backed off from
// the previous run's `now` can fall due a few ms after this run's `now`.
const RETRY_DUE_SLACK_MS = 60 * 1000;
const EXHAUSTED_LOG_HASH_LIMIT = 10;
// Distinct from the other app advisory locks (4019283746-4019283751).
export const FAILED_TX_RETRY_LOCK_KEY = 4019283752;

export function nextRetryAt(attempts: number, now: Date): Date {
  const delay = Math.min(
    RETRY_BASE_DELAY_MS * 2 ** Math.max(attempts - 1, 0),
    RETRY_MAX_DELAY_MS,
  );
  return new Date(now.getTime() + delay);
}

export interface RetryOutcome {
  succeeded: number;
  failed: number;
  orphaned: number;
}

@Injectable()
export class PluginFailedTransactionService {
  private readonly logger = new Logger(PluginFailedTransactionService.name);
  private isRetrying = false;

  constructor(
    @InjectRepository(PluginFailedTransaction)
    private failedTransactionRepository: Repository<PluginFailedTransaction>,
    @InjectRepository(Tx)
    private txRepository: Repository<Tx>,
    @InjectRepository(SyncState)
    private syncStateRepository: Repository<SyncState>,
    @InjectDataSource()
    private dataSource: DataSource,
    private pluginRegistryService: PluginRegistryService,
    private configService: ConfigService,
  ) {}

  /**
   * Record a failed transaction for a plugin
   */
  async recordFailure(
    pluginName: string,
    tx: Tx,
    error: Error,
    pluginVersion: number,
  ): Promise<void> {
    try {
      await this.failedTransactionRepository.upsert(
        {
          plugin_name: pluginName,
          tx_hash: tx.hash,
          error_message: error.message,
          error_trace: error.stack || '',
          version: pluginVersion,
        },
        ['plugin_name', 'tx_hash'],
      );
      this.logger.warn(
        `[${pluginName}] Recorded failed transaction ${tx.hash} at version ${pluginVersion}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to record failure for ${pluginName}/${tx.hash}`,
        error,
      );
    }
  }

  /**
   * Drop parked rows for transactions a plugin has now processed. Never throws:
   * it runs inside indexing, and a leftover row only costs one extra retry.
   */
  async clearFailures(pluginName: string, txHashes: string[]): Promise<void> {
    try {
      await this.deleteRows(pluginName, txHashes);
    } catch (error: any) {
      this.logger.error(
        `[${pluginName}] Failed to clear ${txHashes.length} parked transactions`,
        error,
      );
    }
  }

  /** Drop parked rows for reorged-out transactions, for every plugin. */
  async clearFailuresForTxs(txHashes: string[]): Promise<void> {
    if (txHashes.length === 0) {
      return;
    }
    try {
      await this.failedTransactionRepository.delete({ tx_hash: In(txHashes) });
    } catch (error: any) {
      this.logger.error(
        `Failed to clear parked rows for ${txHashes.length} removed transactions`,
        error,
      );
    }
  }

  // Five minutes off the EVERY_10_MINUTES jobs, the validation pass among them.
  @Cron('0 5-59/10 * * * *')
  async retryDueFailedTransactions(): Promise<void> {
    if (this.configService.get<boolean>('mdw.disableMdwSync', false)) {
      return;
    }
    if (this.isRetrying) {
      return;
    }
    this.isRetrying = true;

    const queryRunner = this.dataSource.createQueryRunner();
    let locked = false;
    try {
      await queryRunner.connect();
      const rows = await queryRunner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [FAILED_TX_RETRY_LOCK_KEY],
      );
      locked = !!rows?.[0]?.locked;
      if (!locked) {
        this.logger.debug(
          'Another instance holds the failed-transaction retry lock; skipping this tick',
        );
        return;
      }
      await this.retryDue(new Date());
    } catch (error: any) {
      this.logger.error('Failed-transaction retry run failed', error);
    } finally {
      if (locked) {
        try {
          await queryRunner.query('SELECT pg_advisory_unlock($1)', [
            FAILED_TX_RETRY_LOCK_KEY,
          ]);
        } catch (error: any) {
          this.logger.error(
            'Failed to release the failed-transaction retry lock',
            error,
          );
        }
      }
      await queryRunner.release().catch(() => undefined);
      this.isRetrying = false;
    }
  }

  async retryDue(now: Date): Promise<void> {
    const syncState = await this.syncStateRepository.findOne({
      where: { id: 'global' },
    });
    if (!syncState?.tip_height) {
      return;
    }
    // BlockValidationService re-runs the last `reorgDepth` blocks below the MDW
    // tip every pass, so those rows are left to it: no double processing, and
    // they may still be reorged out. tip_height can come from the node, ahead
    // of MDW, hence the margin.
    const reorgDepth = this.configService.get<number>('mdw.reorgDepth', 100);
    const belowHeight =
      syncState.tip_height - reorgDepth - RETRY_TIP_MARGIN_BLOCKS;

    for (const plugin of this.pluginRegistryService.getPlugins()) {
      if (plugin.retryParkedFailures === false) {
        continue;
      }
      try {
        await this.retryDueForPlugin(plugin, belowHeight, now);
      } catch (error: any) {
        this.logger.error(
          `[${plugin.name}] Failed to retry parked transactions`,
          error,
        );
      }
    }
  }

  /**
   * Get all failed transactions for a plugin
   */
  async getFailedTransactions(
    pluginName: string,
  ): Promise<PluginFailedTransaction[]> {
    return this.failedTransactionRepository.find({
      where: { plugin_name: pluginName },
      order: { created_at: 'DESC' },
    });
  }

  private async retryDueForPlugin(
    plugin: Plugin,
    belowHeight: number,
    now: Date,
  ): Promise<void> {
    // A version bump can fix what made these fail, so exhausted rows get a
    // fresh set of attempts.
    await this.failedTransactionRepository
      .createQueryBuilder()
      .update(PluginFailedTransaction)
      .set({ attempts: 0, next_retry_at: null, version: plugin.version })
      .where('plugin_name = :pluginName', { pluginName: plugin.name })
      .andWhere('version < :version', { version: plugin.version })
      .execute();

    const total: RetryOutcome = { succeeded: 0, failed: 0, orphaned: 0 };
    for (
      let processed = 0;
      processed < RETRY_MAX_ROWS_PER_PLUGIN_RUN;
      processed += RETRY_BATCH_SIZE
    ) {
      const rows = await this.findDue(plugin.name, belowHeight, now);
      if (rows.length === 0) {
        break;
      }
      // Every row is deleted or backed off past the due cutoff, so the next
      // page is new.
      const outcome = await this.retryRows(plugin, rows, now);
      total.succeeded += outcome.succeeded;
      total.failed += outcome.failed;
      total.orphaned += outcome.orphaned;
    }

    if (total.succeeded + total.failed + total.orphaned > 0) {
      this.logger.log(
        `[${plugin.name}] Retried parked transactions: ${total.succeeded} succeeded, ${total.failed} still failing, ${total.orphaned} no longer in txs`,
      );
    }
  }

  /** Due rows in chain order; orphans first, so the page cap never holds them back. */
  private findDue(
    pluginName: string,
    belowHeight: number,
    now: Date,
  ): Promise<PluginFailedTransaction[]> {
    return this.failedTransactionRepository
      .createQueryBuilder('f')
      .leftJoin(Tx, 'tx', 'tx.hash = f.tx_hash')
      .where('f.plugin_name = :pluginName', { pluginName })
      .andWhere('f.attempts < :maxAttempts', {
        maxAttempts: MAX_RETRY_ATTEMPTS,
      })
      .andWhere('(f.next_retry_at IS NULL OR f.next_retry_at <= :dueBy)', {
        dueBy: new Date(now.getTime() + RETRY_DUE_SLACK_MS),
      })
      .andWhere('(tx.hash IS NULL OR tx.block_height < :belowHeight)', {
        belowHeight,
      })
      .orderBy('tx.block_height', 'ASC', 'NULLS FIRST')
      .addOrderBy('tx.micro_time', 'ASC')
      .addOrderBy('f.tx_hash', 'ASC')
      .limit(RETRY_BATCH_SIZE)
      .getMany();
  }

  private async retryRows(
    plugin: Plugin,
    rows: PluginFailedTransaction[],
    now: Date,
  ): Promise<RetryOutcome> {
    const hashes = rows.map((row) => row.tx_hash);
    const txs = await this.txRepository.find({
      where: { hash: In(hashes) },
      order: { block_height: 'ASC', micro_time: 'ASC', hash: 'ASC' },
    });
    const found = new Set(txs.map((tx) => tx.hash));

    // Removed from txs by a reorg after it failed, so there is nothing to
    // retry. If it comes back, indexing parks it again on failure.
    const orphaned = hashes.filter((hash) => !found.has(hash));
    await this.deleteRows(plugin.name, orphaned);
    if (txs.length === 0) {
      return { succeeded: 0, failed: 0, orphaned: orphaned.length };
    }

    let failures: PluginBatchFailure[];
    try {
      const result = await plugin.processBatch(txs, SyncDirectionEnum.Backward);
      failures = (result && result.failed) || [];
    } catch (error: any) {
      failures = txs.map((tx) => ({ tx, error }));
    }

    const errorByHash = new Map(
      failures.map((failure) => [failure.tx.hash, failure.error]),
    );
    const succeeded = txs
      .map((tx) => tx.hash)
      .filter((hash) => !errorByHash.has(hash));
    await this.deleteRows(plugin.name, succeeded);

    const attemptsByHash = new Map(
      rows.map((row) => [row.tx_hash, row.attempts ?? 0]),
    );
    const exhausted: string[] = [];
    for (const [hash, error] of errorByHash) {
      const attempts = (attemptsByHash.get(hash) ?? 0) + 1;
      if (attempts >= MAX_RETRY_ATTEMPTS) {
        exhausted.push(hash);
      }
      await this.failedTransactionRepository.update(
        { plugin_name: plugin.name, tx_hash: hash },
        {
          attempts,
          next_retry_at: nextRetryAt(attempts, now),
          error_message: error?.message ?? String(error),
          error_trace: error?.stack || '',
          version: plugin.version,
        },
      );
    }
    // Error level, as prod logs nothing below it.
    if (exhausted.length > 0) {
      const shown = exhausted.slice(0, EXHAUSTED_LOG_HASH_LIMIT).join(', ');
      const more = exhausted.length > EXHAUSTED_LOG_HASH_LIMIT ? ', ...' : '';
      this.logger.error(
        `[${plugin.name}] ${exhausted.length} parked transactions are out of retries and need a manual fix: ${shown}${more}`,
      );
    }

    return {
      succeeded: succeeded.length,
      failed: errorByHash.size,
      orphaned: orphaned.length,
    };
  }

  private async deleteRows(
    pluginName: string,
    txHashes: string[],
  ): Promise<void> {
    if (txHashes.length === 0) {
      return;
    }
    await this.failedTransactionRepository.delete({
      plugin_name: pluginName,
      tx_hash: In(txHashes),
    });
  }
}

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { BasePlugin } from '../base-plugin';
import {
  PluginFilter,
  SyncDirection,
  SyncDirectionEnum,
  TxPageCursor,
} from '../plugin.interface';
import {
  ShortsIndexService,
  SHORTS_INDEX_VERSION,
} from '@/shorts/shorts-index.service';
import { ShortsGateway } from '@/shorts/shorts.gateway';
import { ShortsPluginSyncService } from './shorts-plugin-sync.service';
import { ShortsBackfillService } from './shorts-backfill.service';

@Injectable()
export class ShortsPlugin extends BasePlugin implements OnModuleDestroy {
  protected readonly logger = new Logger(ShortsPlugin.name);
  readonly name = 'shorts';
  readonly version = SHORTS_INDEX_VERSION;
  private retry?: NodeJS.Timeout;
  private stopped = false;
  private updating?: Promise<void>;
  private catchingUp?: Promise<void>;

  constructor(
    @InjectRepository(Tx) protected readonly txRepository: Repository<Tx>,
    @InjectRepository(PluginSyncState)
    protected readonly pluginSyncStateRepository: Repository<PluginSyncState>,
    private readonly processor: ShortsPluginSyncService,
    private readonly index: ShortsIndexService,
    private readonly gateway: ShortsGateway,
    private readonly backfill: ShortsBackfillService,
  ) {
    super();
  }

  startFromHeight() {
    return 0;
  }
  filters(): PluginFilter[] {
    const contractIds = this.index
      .contracts()
      .map((contract) => contract.$options.address);
    return [
      {
        type: 'contract_call',
        contractIds,
        predicate: (tx) =>
          tx.type === 'ContractCallTx' &&
          (contractIds.includes(tx.contract_id as `ct_${string}`) ||
            (Array.isArray(tx.raw?.log) &&
              tx.raw.log.some((log) => contractIds.includes(log.address)))),
      },
    ];
  }
  protected getSyncService() {
    return this.processor;
  }
  catchUpToHeight(tipHeight: number): Promise<void> {
    if (this.stopped || process.env.DISABLE_MDW_SYNC === 'true')
      return Promise.resolve();
    if (this.catchingUp) return this.catchingUp;
    this.catchingUp = this.backfill
      .run(tipHeight, () => this.stopped)
      .finally(() => {
        this.catchingUp = undefined;
      });
    return this.catchingUp;
  }
  async processBatch(txs: Tx[], direction: SyncDirection) {
    const result = await this.processor.processBatch(txs, direction);
    if (result.failed.length) this.scheduleRetry();
    return result;
  }
  private scheduleRetry() {
    if (!this.stopped && !this.retry) {
      this.retry = setTimeout(() => {
        this.retry = undefined;
        void this.updateTransactions();
      }, 30000);
      this.retry.unref();
    }
  }

  getUpdateQueries(version: number) {
    const contracts = this.index
      .contracts()
      .map((contract) => contract.$options.address);
    return [
      (repo: Repository<Tx>, limit: number, cursor?: TxPageCursor) => {
        const query = repo
          .createQueryBuilder('tx')
          .where('tx.type=:type', { type: 'ContractCallTx' })
          .andWhere(
            "(tx.contract_id IN (:...contracts) OR tx.data ? 'shorts' OR EXISTS(SELECT 1 FROM plugin_failed_transaction f WHERE f.plugin_name='shorts' AND f.tx_hash=tx.hash))",
            { contracts },
          )
          .andWhere(
            "((tx.data->'shorts'->>'_version') IS DISTINCT FROM :version OR EXISTS(SELECT 1 FROM plugin_failed_transaction f WHERE f.plugin_name='shorts' AND f.tx_hash=tx.hash))",
            { version: String(version) },
          );
        if (cursor)
          query.andWhere(
            '(tx.block_height,tx.micro_time,tx.hash) > (CAST(:height AS int),CAST(:time AS bigint),CAST(:hash AS text))',
            {
              height: cursor.block_height,
              time: cursor.micro_time,
              hash: cursor.hash,
            },
          );
        return query
          .orderBy('tx.block_height', 'ASC')
          .addOrderBy('tx.micro_time', 'ASC')
          .addOrderBy('tx.hash', 'ASC')
          .take(limit)
          .getMany();
      },
    ];
  }

  // The registry invokes this on startup. Unlike the base decode-only sweep,
  // replay must rebuild the derived rows as well as update the version marker.
  updateTransactions(batchSize = 100): Promise<void> {
    if (this.updating) return this.updating;
    this.updating = this.replay(Math.min(100, Math.max(1, batchSize)))
      .catch((error) => {
        this.scheduleRetry();
        this.logger.warn(
          `Shorts index catch-up will retry: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.updating = undefined;
      });
    return this.updating;
  }
  private async replay(batchSize: number) {
    if (process.env.DISABLE_MDW_SYNC === 'true') return;
    const query = this.getUpdateQueries(this.version)[0];
    while (!this.stopped) {
      const txs = await query(this.txRepository, batchSize);
      if (!txs.length) break;
      const result = await this.processBatch(txs, SyncDirectionEnum.Backward);
      if (result.failed.length) throw result.failed[0].error;
    }
  }
  async onReorg(hashes: string[]) {
    // Canonical tx deletion already cascaded through the FK in this transaction.
    if (hashes.length) {
      await this.index.removed(hashes);
      await this.gateway.changed();
    }
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
  }
}

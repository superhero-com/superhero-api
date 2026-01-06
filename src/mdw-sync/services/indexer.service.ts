import { fetchJson } from '@/utils/common';
import { ITransaction } from '@/utils/types';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { KeyBlock } from '../entities/key-block.entity';
import { MicroBlock } from '../entities/micro-block.entity';
import { PluginSyncState } from '../entities/plugin-sync-state.entity';
import { SyncState } from '../entities/sync-state.entity';
import { Tx } from '../entities/tx.entity';
import { BlockValidationService } from './block-validation.service';
import { PluginBatchProcessorService } from './plugin-batch-processor.service';
import { PluginRegistryService } from './plugin-registry.service';
import { MicroBlockService } from './micro-block.service';
import { BlockSyncService } from './block-sync.service';
import { SyncDirectionEnum } from '../types/sync-direction';

@Injectable()
export class IndexerService implements OnModuleInit {
  private readonly logger = new Logger(IndexerService.name);
  private isRunning = false;
  private syncInterval: NodeJS.Timeout;
  private schemaWaitTimer?: NodeJS.Timeout;
  private schemaWaitLogged = false;

  constructor(
    @InjectRepository(Tx)
    private txRepository: Repository<Tx>,
    @InjectRepository(KeyBlock)
    private blockRepository: Repository<KeyBlock>,
    @InjectRepository(MicroBlock)
    private microBlockRepository: Repository<MicroBlock>,
    @InjectRepository(SyncState)
    private syncStateRepository: Repository<SyncState>,
    @InjectRepository(PluginSyncState)
    private pluginSyncStateRepository: Repository<PluginSyncState>,
    private blockValidationService: BlockValidationService,
    private configService: ConfigService,
    private dataSource: DataSource,
    private eventEmitter: EventEmitter2,
    private pluginBatchProcessor: PluginBatchProcessorService,
    private pluginRegistryService: PluginRegistryService,
    private microBlockService: MicroBlockService,
    private blockSyncService: BlockSyncService,
  ) {}

  async onModuleInit() {
    const disableMdwSync = this.configService.get<boolean>('mdw.disableMdwSync', false);
    
    // Plugin sync states are initialized by PluginRegistryService.onModuleInit()
    // which runs before this, so they should already exist. But we verify here
    // to ensure backward indexer doesn't start until plugins are ready.
    // The initializePluginSyncStates() method is idempotent, so calling it again is safe.
    await this.pluginRegistryService.initializePluginSyncStates();
    
    if (!disableMdwSync) {
      // Defer indexer start until DB schema is ready (older DBs may not have indexer_head_height yet).
      void this.startWhenSchemaReady();
    } else {
      this.logger.log('MDW sync is disabled, skipping sync loop start');
    }
  }

  private async startWhenSchemaReady(): Promise<void> {
    try {
      const hasIndexerHeadColumn = await this.hasSyncStateColumn('indexer_head_height');
      if (!hasIndexerHeadColumn) {
        if (!this.schemaWaitLogged) {
          this.schemaWaitLogged = true;
          this.logger.warn(
            `SyncState.indexer_head_height column is missing. Waiting for DB sync/migration before starting MDW indexer...`,
          );
        }

        // Avoid scheduling multiple timers
        if (!this.schemaWaitTimer) {
          this.schemaWaitTimer = setTimeout(() => {
            this.schemaWaitTimer = undefined;
            void this.startWhenSchemaReady();
          }, 5000);
        }
        return;
      }

      // Schema ready: initialize state and start sync loop
      await this.initializeSyncState();
      this.startSync();
      this.logger.log('MDW indexer started (schema ready)');
    } catch (error: any) {
      this.logger.error('Failed to start MDW indexer (schema readiness check)', error);
      // Retry with backoff-ish delay
      if (!this.schemaWaitTimer) {
        this.schemaWaitTimer = setTimeout(() => {
          this.schemaWaitTimer = undefined;
          void this.startWhenSchemaReady();
        }, 10000);
      }
    }
  }

  private async hasSyncStateColumn(columnName: string): Promise<boolean> {
    // Works even when TypeORM metadata includes new columns that aren't in DB yet.
    const rows = await this.dataSource.query(
      `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'sync_state'
        AND column_name = $1
      LIMIT 1
      `,
      [columnName],
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  private async initializeSyncState() {
    const existing = await this.syncStateRepository.findOne({
      where: { id: 'global' },
    });

    if (!existing) {
      const middlewareUrl = this.configService.get<string>('mdw.middlewareUrl');
      const status = await fetchJson(`${middlewareUrl}/v3/status`);
      const tipHeight = status.mdw_height;

      await this.syncStateRepository.save({
        id: 'global',
        last_synced_height: 0,
        last_synced_hash: '',
        tip_height: tipHeight,
        is_bulk_mode: false,
        backward_synced_height: tipHeight, // Start from tip, will decrease as we sync backward
        live_synced_height: 0, // Start from 0, will increase as live indexer syncs forward
        indexer_head_height: tipHeight, // Indexer-owned "final" head height
      });
    } else {
      // Migrate existing sync state
      const updateData: Partial<SyncState> = {};

      if (existing.backward_synced_height === null || existing.backward_synced_height === undefined) {
        updateData.backward_synced_height = existing.tip_height || existing.last_synced_height;
      }

      if (existing.live_synced_height === null || existing.live_synced_height === undefined) {
        updateData.live_synced_height = existing.last_synced_height || 0;
      }

      if (Object.keys(updateData).length > 0) {
        await this.syncStateRepository.update({ id: 'global' }, updateData);
      }

      // Initialize indexer_head_height if it's null (don't overwrite existing values).
      // We intentionally don't read the column here (it's select:false); we use a COALESCE update instead.
      const initHeight = existing.tip_height || existing.last_synced_height || 0;
      await this.syncStateRepository
        .createQueryBuilder()
        .update(SyncState)
        .set({
          indexer_head_height: () =>
            'COALESCE(indexer_head_height, :initHeight)',
        })
        .where('id = :id', { id: 'global' })
        .setParameters({ initHeight })
        .execute();
    }
  }


  private startSync() {
    const syncIntervalMs = this.configService.get<number>(
      'mdw.syncIntervalMs',
      3000,
    );

    this.syncInterval = setInterval(async () => {
      if (!this.isRunning) {
        await this.sync();
      }
    }, syncIntervalMs);
  }

  async sync() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    try {
      // Note: Block validation runs periodically via cron job, not during sync

      // Get current sync state
      const syncState = await this.syncStateRepository
        .createQueryBuilder('sync_state')
        .addSelect('sync_state.indexer_head_height')
        .where('sync_state.id = :id', { id: 'global' })
        .getOne();

      if (!syncState) {
        this.logger.error('No sync state found');
        return;
      }

      // Get tip height from MDW
      const middlewareUrl = this.configService.get<string>('mdw.middlewareUrl');
      const status = await fetchJson(`${middlewareUrl}/v3/status`);
      const tipHeight = status.mdw_height;

      // Update tip height
      await this.syncStateRepository.update(
        { id: 'global' },
        { tip_height: tipHeight },
      );

      // Get target backward sync height (stop at 0 or configured start height)
      const targetBackwardHeight = 0; // Could be configurable in the future
      const currentBackwardHeight = syncState.backward_synced_height ?? tipHeight;

      // Forward catch-up (restart gap fill): ensure we sync new blocks that happened while the server was down
      // BEFORE resuming backward backfill.
      const forwardCaughtUp = await this.syncForwardCatchupIfNeeded(
        tipHeight,
        syncState.indexer_head_height ?? currentBackwardHeight,
      );
      if (!forwardCaughtUp) {
        // Still catching up; don't run backward sync until we're fully caught up to remote tip.
        return;
      }

      // Check if backward sync is complete
      if (currentBackwardHeight <= targetBackwardHeight) {
        this.logger.debug('Backward sync complete, no more blocks to sync backward');
        return;
      }

      // Determine sync mode based on how much we need to sync backward
      const remainingBlocks = currentBackwardHeight - targetBackwardHeight;
      const shouldUseBulkMode = remainingBlocks > this.configService.get<number>(
        'mdw.bulkModeThreshold',
        100,
      );

      // Update bulk mode state if it changed
      if (syncState.is_bulk_mode !== shouldUseBulkMode) {
        await this.syncStateRepository.update(
          { id: 'global' },
          { is_bulk_mode: shouldUseBulkMode },
        );

        // Emit event when transitioning from bulk to normal mode
        if (syncState.is_bulk_mode && !shouldUseBulkMode) {
          this.logger.log('Transitioning from bulk mode to normal backward sync mode');
          this.eventEmitter.emit('sync.bulk-complete');
        } else if (!syncState.is_bulk_mode && shouldUseBulkMode) {
          this.logger.log('Entering bulk mode for backward sync');
        }

        // Emit event to invalidate subscriber cache
        this.eventEmitter.emit('sync.bulk-mode-changed');
      }

      // Sync backward: from currentBackwardHeight down to targetBackwardHeight
      const batchSize = shouldUseBulkMode
        ? this.configService.get<number>('mdw.bulkModeBatchBlocks', 1000)
        : this.configService.get<number>('mdw.backfillBatchBlocks', 50);

      // Calculate range: endHeight is higher (more recent), startHeight is lower (older)
      // We sync from endHeight down to startHeight
      const endHeight = currentBackwardHeight;
      const startHeight = Math.max(targetBackwardHeight, endHeight - batchSize + 1);

      if (shouldUseBulkMode) {
        // Use parallel processing in bulk mode
        await this.syncBlocksParallelBackward(startHeight, endHeight);
      } else {
        // Use sequential processing
        await this.blockSyncService.syncBlockRange(startHeight, endHeight, true);
      }

      // Indexer-owned head height should never regress; update it to at least the endHeight we've processed.
      await this.updateIndexerHeadHeightAtLeast(endHeight);

      // Update backward sync state (decrease backward_synced_height as we go backward)
      const newBackwardHeight = startHeight - 1;
      await this.syncStateRepository.update(
        { id: 'global' },
        {
          backward_synced_height: newBackwardHeight,
          last_synced_height: newBackwardHeight, // Keep for backward compatibility
          last_synced_hash: '', // Will be updated when we store the block
        },
      );

      this.isRunning = false;
      // Check if there's more work to do and continue immediately if so
      // This allows fast continuous syncing when batches complete quickly
      if (newBackwardHeight > targetBackwardHeight) {
        return this.sync()
      }
    } catch (error: any) {
      this.logger.error('Backward sync failed', error);
    } finally {
      this.isRunning = false;
    }
  }


  /**
   * Forward catch-up for the gap created while the server was down.
   *
   * Example: we previously stored blocks up to 1000, server stops, network reaches 1200.
   * On restart we want to sync 1001-1200 first (forward), then resume backward backfill.
   *
   * Returns:
   * - true  => caught up (or no catch-up needed), safe to proceed with backward sync
   * - false => catch-up is still in progress (likely due to per-tick cap); skip backward this tick
   */
  private async syncForwardCatchupIfNeeded(
    remoteTipHeight: number,
    indexerHeadHeight: number,
  ): Promise<boolean> {
    if (indexerHeadHeight >= remoteTipHeight) {
      return true;
    }

    const batchBlocks = this.configService.get<number>(
      'mdw.forwardCatchupBatchBlocks',
      200,
    );
    const maxBlocksPerTick = this.configService.get<number>(
      'mdw.forwardCatchupMaxBlocksPerTick',
      0,
    );

    const startHeight = indexerHeadHeight + 1;
    const endHeight = remoteTipHeight;
    const totalMissing = endHeight - startHeight + 1;
    const cappedTotal =
      maxBlocksPerTick && maxBlocksPerTick > 0
        ? Math.min(totalMissing, maxBlocksPerTick)
        : totalMissing;

    this.logger.log(
      `Forward catch-up: indexerHead=${indexerHeadHeight}, remoteTip=${remoteTipHeight}, syncing ${startHeight}-${startHeight + cappedTotal - 1} (${cappedTotal}/${totalMissing} missing blocks this tick)`,
    );

    let processed = 0;
    while (processed < cappedTotal) {
      const batchStart = startHeight + processed;
      const batchEnd = Math.min(endHeight, batchStart + batchBlocks - 1);

      await this.blockSyncService.syncBlockRange(batchStart, batchEnd, false);
      await this.updateLiveSyncedHeightAtLeast(batchEnd);
      await this.updateIndexerHeadHeightAtLeast(batchEnd);

      processed += batchEnd - batchStart + 1;
      this.logger.log(
        `Forward catch-up progress: synced ${batchStart}-${batchEnd} (${processed}/${cappedTotal} this tick)`,
      );
    }

    const fullyCaughtUp = indexerHeadHeight + cappedTotal >= remoteTipHeight;
    if (fullyCaughtUp) {
      this.logger.log(
        `Forward catch-up complete: indexerHead reached remoteTip=${remoteTipHeight}`,
      );
      return true;
    }

    this.logger.log(
      `Forward catch-up paused: ${remoteTipHeight - (indexerHeadHeight + cappedTotal)} blocks still missing; will continue next tick`,
    );
    return false;
  }

  /**
   * Monotonic update to avoid regressing live_synced_height if websocket live indexing advanced further.
   */
  private async updateLiveSyncedHeightAtLeast(newHeight: number): Promise<void> {
    await this.syncStateRepository
      .createQueryBuilder()
      .update(SyncState)
      .set({
        live_synced_height: () =>
          'GREATEST(COALESCE(live_synced_height, 0), :newHeight)',
      })
      .where('id = :id', { id: 'global' })
      .setParameters({ newHeight })
      .execute();
  }

  /**
   * Monotonic update for indexer-owned "final" head height.
   * This value is used for forward catch-up decisions and must not be affected by websocket live indexing.
   */
  private async updateIndexerHeadHeightAtLeast(newHeight: number): Promise<void> {
    await this.syncStateRepository
      .createQueryBuilder()
      .update(SyncState)
      .set({
        indexer_head_height: () =>
          'GREATEST(COALESCE(indexer_head_height, 0), :newHeight)',
      })
      .where('id = :id', { id: 'global' })
      .setParameters({ newHeight })
      .execute();
  }

  /**
   * Parallel processing of multiple block ranges for bulk backward sync
   */
  private async syncBlocksParallelBackward(
    startHeight: number,
    endHeight: number,
  ): Promise<void> {
    const parallelWorkers = this.configService.get<number>(
      'mdw.parallelWorkers',
      6,
    );
    const batchSize = this.configService.get<number>(
      'mdw.bulkModeBatchBlocks',
      1000,
    );

    const ranges: Array<{ start: number; end: number }> = [];

    // Split the range into chunks for parallel processing (going backward)
    // Process from endHeight down to startHeight
    for (let i = endHeight; i >= startHeight; i -= batchSize) {
      ranges.push({
        start: Math.max(startHeight, i - batchSize + 1),
        end: i,
      });
    }

    // Process ranges in parallel batches
    for (let i = 0; i < ranges.length; i += parallelWorkers) {
      const batch = ranges.slice(i, i + parallelWorkers);
      await Promise.all(
        batch.map((range) =>
          this.blockSyncService.syncBlockRange(range.start, range.end, true).catch((error: any) => {
            this.logger.error(
              `Failed to sync range ${range.start}-${range.end}`,
              error,
            );
            throw error;
          }),
        ),
      );

      // Log progress
      const completed = Math.min(i + parallelWorkers, ranges.length);
      this.logger.log(
        `Backward bulk sync progress: ${completed}/${ranges.length} ranges completed`,
      );
    }
  }

  /**
   * Get the current running status of the backward sync
   */
  getIsRunning(): boolean {
    return this.isRunning;
  }

  onModuleDestroy() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }
    if (this.schemaWaitTimer) {
      clearTimeout(this.schemaWaitTimer);
    }
  }
}

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
    await this.initializeSyncState();
    // Plugin sync states are initialized by PluginRegistryService.onModuleInit()
    // which runs before this, so they should already exist. But we verify here
    // to ensure backward indexer doesn't start until plugins are ready.
    // The initializePluginSyncStates() method is idempotent, so calling it again is safe.
    await this.pluginRegistryService.initializePluginSyncStates();
    this.startSync();
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
      });
    } else {
      // Migrate existing sync state
      if (existing.backward_synced_height === null || existing.backward_synced_height === undefined) {
        await this.syncStateRepository.update(
          { id: 'global' },
          {
            backward_synced_height: existing.tip_height || existing.last_synced_height,
            live_synced_height: existing.last_synced_height || 0,
          },
        );
      }
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
      const syncState = await this.syncStateRepository.findOne({
        where: { id: 'global' },
      });

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

      // Update backward sync state (decrease backward_synced_height as we go backward)
      await this.syncStateRepository.update(
        { id: 'global' },
        {
          backward_synced_height: startHeight - 1,
          last_synced_height: startHeight - 1, // Keep for backward compatibility
          last_synced_hash: '', // Will be updated when we store the block
        },
      );
    } catch (error: any) {
      this.logger.error('Backward sync failed', error);
    } finally {
      this.isRunning = false;
    }
    this.sync();
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
  }
}

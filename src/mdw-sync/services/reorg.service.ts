import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { KeyBlock } from '../entities/key-block.entity';
import { Tx } from '../entities/tx.entity';
import { SyncState } from '../entities/sync-state.entity';
import { PluginSyncState } from '../entities/plugin-sync-state.entity';
import { fetchJson } from '@/utils/common';
import { ConfigService } from '@nestjs/config';
import { PluginBatchProcessorService } from './plugin-batch-processor.service';

@Injectable()
export class ReorgService {
  private readonly logger = new Logger(ReorgService.name);
  private isCheckingReorg = false;

  constructor(
    @InjectRepository(KeyBlock)
    private blockRepository: Repository<KeyBlock>,
    @InjectRepository(Tx)
    private txRepository: Repository<Tx>,
    @InjectRepository(SyncState)
    private syncStateRepository: Repository<SyncState>,
    @InjectRepository(PluginSyncState)
    private pluginSyncStateRepository: Repository<PluginSyncState>,
    private configService: ConfigService,
    private dataSource: DataSource,
    private pluginBatchProcessor: PluginBatchProcessorService,
  ) {}

  onModuleInit() {
    void this.checkReorgPeriodically();
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async checkReorgPeriodically() {
    if (this.isCheckingReorg) {
      return;
    }

    this.isCheckingReorg = true;

    try {
      await this.detectAndHandleReorg();
    } catch (error: any) {
      this.logger.error('Error during periodic reorg check', error);
    } finally {
      this.isCheckingReorg = false;
    }
  }

  async detectAndHandleReorg(): Promise<boolean> {
    const reorgDepth = this.configService.get<number>('mdw.reorgDepth', 100);
    const middlewareUrl = this.configService.get<string>('mdw.middlewareUrl');

    try {
      // Get current sync state
      const syncState = await this.syncStateRepository.findOne({
        where: { id: 'global' },
      });

      if (!syncState) {
        this.logger.warn('No sync state found, skipping reorg check');
        return false;
      }

      // Get tip height from MDW
      const tipResponse = await fetchJson(`${middlewareUrl}/v3/status`);
      const tipHeight = tipResponse.mdw_height || tipResponse.top_block_height;

      // Check blocks in the reorg window: last 100 blocks (reorgDepth)
      // Similar to validateBlocksRange pattern in sync-blocks.service.ts
      const startHeight = Math.max(1, tipHeight - reorgDepth);
      const endHeight = tipHeight;

      // Use live_synced_height if available, otherwise fall back to last_synced_height
      const maxSyncedHeight = syncState.live_synced_height ?? syncState.last_synced_height ?? 0;

      // Only check blocks that we have synced
      const checkEndHeight = Math.min(endHeight, maxSyncedHeight);

      if (checkEndHeight < startHeight) {
        return false; // No blocks to check
      }

      // Check blocks from startHeight to checkEndHeight (going backward)
      for (let height = checkEndHeight; height >= startHeight; height--) {
        const storedBlock = await this.blockRepository.findOne({
          where: { height },
        });

        if (!storedBlock) {
          continue; // Block not stored yet
        }

        // Fetch block from MDW
        const mdwBlock = await fetchJson(
          `${middlewareUrl}/v3/key-blocks/${height}`,
        );

        if (mdwBlock.hash !== storedBlock.hash) {
          this.logger.warn(`Reorg detected at height ${height}`, {
            storedHash: storedBlock.hash,
            mdwHash: mdwBlock.hash,
          });

          await this.handleReorg(height);
          return true;
        }
      }

      return false;
    } catch (error: any) {
      this.logger.error('Error during reorg detection', error);
      return false;
    }
  }

  private async handleReorg(divergenceHeight: number): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log(`Handling reorg from height ${divergenceHeight}`);

      // First, collect transaction hashes that will be deleted
      const transactionsToDelete = await queryRunner.manager.query(
        'SELECT hash FROM txs WHERE block_height >= $1',
        [divergenceHeight],
      );
      const removedTxHashes = transactionsToDelete.map((row: any) => row.hash);

      // Delete transactions, micro-blocks, and blocks from divergence height onwards
      await queryRunner.manager.query(
        'DELETE FROM txs WHERE block_height >= $1',
        [divergenceHeight],
      );

      await queryRunner.manager.query(
        'DELETE FROM micro_blocks WHERE height >= $1',
        [divergenceHeight],
      );

      await queryRunner.manager.query(
        'DELETE FROM mdw_block WHERE height >= $1',
        [divergenceHeight],
      );

      // Update sync state
      await queryRunner.manager.update(
        SyncState,
        { id: 'global' },
        {
          last_synced_height: divergenceHeight - 1,
          live_synced_height: divergenceHeight - 1, // Also update live_synced_height
          last_synced_hash: '', // Will be updated by indexer
        },
      );

      // Update plugin sync states
      // Update both backward_synced_height and live_synced_height if they exceed the divergence height
      const newHeight = divergenceHeight - 1;
      await queryRunner.manager.query(
        `UPDATE plugin_sync_state 
         SET last_synced_height = LEAST(last_synced_height, $1),
             backward_synced_height = CASE 
               WHEN backward_synced_height IS NOT NULL AND backward_synced_height >= $1 
               THEN LEAST(backward_synced_height, $1) 
               ELSE backward_synced_height 
             END,
             live_synced_height = CASE 
               WHEN live_synced_height IS NOT NULL AND live_synced_height >= $1 
               THEN LEAST(live_synced_height, $1) 
               ELSE live_synced_height 
             END
         WHERE last_synced_height >= $1`,
        [newHeight],
      );

      await queryRunner.commitTransaction();

      this.logger.log(
        `Reorg handled successfully from height ${divergenceHeight}. ${removedTxHashes.length} transactions removed.`,
      );

      // Notify plugins about removed transactions (after commit)
      if (removedTxHashes.length > 0) {
        await this.pluginBatchProcessor.handleReorg(removedTxHashes);
      }
    } catch (error: any) {
      await queryRunner.rollbackTransaction();
      this.logger.error('Failed to handle reorg', error);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}

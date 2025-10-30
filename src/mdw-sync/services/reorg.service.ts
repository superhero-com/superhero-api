import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { KeyBlock } from '../entities/key-block.entity';
import { Tx } from '../entities/tx.entity';
import { SyncState } from '../entities/sync-state.entity';
import { PluginSyncState } from '../entities/plugin-sync-state.entity';
import { PluginRegistryService } from './plugin-registry.service';
import { fetchJson } from '@/utils/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ReorgService {
  private readonly logger = new Logger(ReorgService.name);

  constructor(
    @InjectRepository(KeyBlock)
    private blockRepository: Repository<KeyBlock>,
    @InjectRepository(Tx)
    private txRepository: Repository<Tx>,
    @InjectRepository(SyncState)
    private syncStateRepository: Repository<SyncState>,
    @InjectRepository(PluginSyncState)
    private pluginSyncStateRepository: Repository<PluginSyncState>,
    private pluginRegistry: PluginRegistryService,
    private configService: ConfigService,
    private dataSource: DataSource,
  ) {}

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
      const tipHeight = tipResponse.top_block_height;

      if (tipHeight <= syncState.last_synced_height) {
        return false; // No new blocks to check
      }

      // Check blocks in the reorg window
      const startHeight = Math.max(1, tipHeight - reorgDepth);
      const endHeight = Math.min(tipHeight, syncState.last_synced_height);

      for (let height = endHeight; height >= startHeight; height--) {
        const storedBlock = await this.blockRepository.findOne({
          where: { height },
        });

        if (!storedBlock) {
          continue; // Block not stored yet
        }

        // Fetch block from MDW
        const mdwBlock = await fetchJson(
          `${middlewareUrl}/v3/blocks/${height}`,
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
    } catch (error) {
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

      // Delete transactions and blocks from divergence height onwards
      await queryRunner.manager.query(
        'DELETE FROM mdw_tx WHERE block_height >= $1',
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
          last_synced_hash: '', // Will be updated by indexer
        },
      );

      // Update plugin sync states
      await queryRunner.manager.query(
        'UPDATE mdw_plugin_sync_state SET last_synced_height = LEAST(last_synced_height, $1) WHERE last_synced_height >= $1',
        [divergenceHeight - 1],
      );

      await queryRunner.commitTransaction();

      // Notify plugins about reorg
      const plugins = this.pluginRegistry.getPlugins();
      for (const plugin of plugins) {
        if (plugin.onReorg) {
          try {
            await plugin.onReorg(divergenceHeight);
          } catch (error) {
            this.logger.error(
              `Plugin ${plugin.name} reorg handler failed`,
              error,
            );
          }
        }
      }

      this.logger.log(
        `Reorg handled successfully from height ${divergenceHeight}`,
      );
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error('Failed to handle reorg', error);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}

import { fetchJson } from '@/utils/common';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { Tx } from '../entities/tx.entity';
import { SyncDirectionEnum } from '../types/sync-direction';
import { BlockSyncService } from './block-sync.service';
import { PluginBatchProcessorService } from './plugin-batch-processor.service';

@Injectable()
export class BlockValidationService {
  private readonly logger = new Logger(BlockValidationService.name);
  private isValidating = false;

  constructor(
    @InjectRepository(Tx)
    private txRepository: Repository<Tx>,
    private configService: ConfigService,
    private pluginBatchProcessor: PluginBatchProcessorService,
    private blockSyncService: BlockSyncService,
  ) {}

  onModuleInit() {
    void this.validateBlocksPeriodically();
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async validateBlocksPeriodically() {
    const disableMdwSync = this.configService.get<boolean>('mdw.disableMdwSync', false);
    if (disableMdwSync) {
      this.logger.debug('MDW sync is disabled, skipping block validation');
      return;
    }

    if (this.isValidating) {
      return;
    }

    this.isValidating = true;

    try {
      await this.validateAndRefreshBlocks();
    } catch (error: any) {
      this.logger.error('Error during periodic block validation', error);
    } finally {
      this.isValidating = false;
    }
  }

  async validateAndRefreshBlocks(): Promise<void> {
    const validationDepth = this.configService.get<number>('mdw.reorgDepth', 100);
    const middlewareUrl = this.configService.get<string>('mdw.middlewareUrl');

    try {
      // Get tip height from MDW
      const tipResponse = await fetchJson(`${middlewareUrl}/v3/status`);
      const tipHeight = tipResponse.mdw_height || tipResponse.top_block_height;

      // Always validate last 100 blocks (validationDepth) from tip height
      const startHeight = Math.max(1, tipHeight - validationDepth);
      const endHeight = tipHeight;

      this.logger.log(
        `Validating and refreshing blocks from height ${startHeight} to ${endHeight}`,
      );

      // Refetch blocks, microblocks, and transactions using BlockSyncService
      // Get transaction hashes grouped by block height that were just synced
      const syncedTxHashesByBlock = await this.blockSyncService.syncBlockRange(startHeight, endHeight, false);

      // For each block, compare stored transactions with refetched transactions
      // and remove transactions that no longer exist
      for (let height = startHeight; height <= endHeight; height++) {
        const refetchedTxHashes = syncedTxHashesByBlock.get(height) || [];
        await this.validateBlockTransactions(height, refetchedTxHashes);
      }

      this.logger.log(
        `Successfully validated and refreshed blocks from height ${startHeight} to ${endHeight}`,
      );
    } catch (error: any) {
      this.logger.error('Error during block validation', error);
      throw error;
    }
  }

  private async validateBlockTransactions(
    blockHeight: number,
    refetchedTxHashes: string[],
  ): Promise<void> {
    try {
      if (refetchedTxHashes.length === 0) {
        // No transactions in this block, remove all stored transactions for this block
        const storedTxs = await this.txRepository.find({
          where: { block_height: blockHeight },
        });

        if (storedTxs.length > 0) {
          const removedHashes = storedTxs.map((tx) => tx.hash);
          await this.txRepository.delete({ block_height: blockHeight });
          this.logger.debug(
            `Removed ${removedHashes.length} transactions from block ${blockHeight} (block has no transactions)`,
          );

          // Notify plugins about removed transactions
          if (removedHashes.length > 0) {
            await this.pluginBatchProcessor.handleReorg(removedHashes);
          }
        }
        return;
      }

      // Get stored transactions for this block that are NOT in refetched data
      // Using Not(In(...)) to filter directly in the database query, avoiding large data in memory
      const storedTxs = await this.txRepository.find({
        where: { 
          block_height: blockHeight,
          hash: Not(In(refetchedTxHashes)),
        },
        select: ['hash'], // Only select hash field to minimize memory usage
      });
      const transactionsToRemove = storedTxs.map((tx) => tx.hash);

      // Remove transactions that no longer exist
      if (transactionsToRemove.length > 0) {
        await this.txRepository
          .createQueryBuilder()
          .delete()
          .where('block_height = :blockHeight', { blockHeight })
          .andWhere('hash IN (:...hashes)', { hashes: transactionsToRemove })
          .execute();

        this.logger.debug(
          `Removed ${transactionsToRemove.length} transactions from block ${blockHeight} that no longer exist`,
        );

        // Notify plugins about removed transactions
        await this.pluginBatchProcessor.handleReorg(transactionsToRemove);
      }

      // Process all refetched transactions through plugins (even if already stored)
      // Fetch the actual transaction entities from DB (they were just synced by BlockSyncService)
      const refetchedTxs = await this.txRepository.find({
        where: {
          block_height: blockHeight,
          hash: In(refetchedTxHashes),
        },
      });

      if (refetchedTxs.length > 0) {
        // Process through plugins (plugins may need to reprocess even if already stored)
        await this.pluginBatchProcessor.processBatch(
          refetchedTxs,
          SyncDirectionEnum.Backward,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Error validating transactions for block ${blockHeight}`,
        error,
      );
      // Don't throw - continue with next block
    }
  }

  /**
   * Get the current validation status
   */
  getIsValidating(): boolean {
    return this.isValidating;
  }

}


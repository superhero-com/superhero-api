import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { PluginFailedTransaction } from '../entities/plugin-failed-transaction.entity';
import { PluginSyncState } from '../entities/plugin-sync-state.entity';
import { Tx } from '../entities/tx.entity';
import { PluginRegistryService } from './plugin-registry.service';
import { SyncDirection, SyncDirectionEnum } from '../types/sync-direction';

@Injectable()
export class PluginFailedTransactionService {
  private readonly logger = new Logger(PluginFailedTransactionService.name);

  constructor(
    @InjectRepository(PluginFailedTransaction)
    private failedTransactionRepository: Repository<PluginFailedTransaction>,
    @InjectRepository(Tx)
    private txRepository: Repository<Tx>,
    @InjectRepository(PluginSyncState)
    private pluginSyncStateRepository: Repository<PluginSyncState>,
    private pluginRegistryService: PluginRegistryService,
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
   * Retry failed transactions for a plugin when version changes
   */
  async retryFailedTransactions(
    pluginName: string,
    oldVersion: number,
    newVersion: number,
  ): Promise<void> {
    try {
      // Find all failed transactions for this plugin at the old version
      const failedTransactions = await this.failedTransactionRepository.find({
        where: {
          plugin_name: pluginName,
          version: oldVersion,
        },
      });

      if (failedTransactions.length === 0) {
        return;
      }

      this.logger.log(
        `[${pluginName}] Retrying ${failedTransactions.length} failed transactions from version ${oldVersion} to ${newVersion}`,
      );

      const plugin = this.pluginRegistryService.getPluginByName(pluginName);
      if (!plugin) {
        this.logger.warn(`[${pluginName}] Plugin not found, skipping retry`);
        return;
      }

      // Fetch transactions from database
      const txHashes = failedTransactions.map((ft) => ft.tx_hash);
      const transactions = await this.txRepository.find({
        where: {
          hash: In(txHashes),
        },
      });

      // Process transactions in batches
      // Failed transaction retries are treated as 'backward' sync since they're typically historical
      const batchSize = 100;
      for (let i = 0; i < transactions.length; i += batchSize) {
        const batch = transactions.slice(i, i + batchSize);
        try {
          await plugin.processBatch(batch, SyncDirectionEnum.Backward);
          // Remove successful retries from failed transactions
          const successfulHashes = batch.map((tx) => tx.hash);
          await this.failedTransactionRepository
            .createQueryBuilder()
            .delete()
            .from(PluginFailedTransaction)
            .where('plugin_name = :pluginName', { pluginName })
            .andWhere('tx_hash IN (:...hashes)', { hashes: successfulHashes })
            .execute();
          this.logger.log(
            `[${pluginName}] Successfully retried ${successfulHashes.length} transactions`,
          );
        } catch (error: any) {
          // Update version for failed retries
          const failedHashes = batch.map((tx) => tx.hash);
          // Use query builder for bulk update with IN clause
          await this.failedTransactionRepository
            .createQueryBuilder()
            .update(PluginFailedTransaction)
            .set({
              version: newVersion,
              error_message: error.message,
              error_trace: error.stack || '',
            })
            .where('plugin_name = :pluginName', { pluginName })
            .andWhere('tx_hash IN (:...hashes)', { hashes: failedHashes })
            .execute();
          this.logger.error(
            `[${pluginName}] Failed to retry batch, updated to version ${newVersion}`,
            error,
          );
        }
      }
    } catch (error: any) {
      this.logger.error(
        `Failed to retry failed transactions for ${pluginName}`,
        error,
      );
    }
  }

  /**
   * Retry a single failed transaction
   */
  async retryFailedTransaction(
    pluginName: string,
    txHash: string,
  ): Promise<boolean> {
    try {
      const failedTx = await this.failedTransactionRepository.findOne({
        where: {
          plugin_name: pluginName,
          tx_hash: txHash,
        },
      });

      if (!failedTx) {
        return false;
      }

      const tx = await this.txRepository.findOne({
        where: { hash: txHash },
      });

      if (!tx) {
        this.logger.warn(
          `[${pluginName}] Transaction ${txHash} not found in database`,
        );
        return false;
      }

      const plugin = this.pluginRegistryService.getPluginByName(pluginName);
      if (!plugin) {
        this.logger.warn(`[${pluginName}] Plugin not found`);
        return false;
      }

      // Failed transaction retries are treated as 'backward' sync since they're typically historical
      await plugin.processBatch([tx], SyncDirectionEnum.Backward);
      await this.failedTransactionRepository.delete({
        plugin_name: pluginName,
        tx_hash: txHash,
      });

      this.logger.log(
        `[${pluginName}] Successfully retried transaction ${txHash}`,
      );
      return true;
    } catch (error: any) {
      this.logger.error(
        `[${pluginName}] Failed to retry transaction ${txHash}`,
        error,
      );
      return false;
    }
  }

  /**
   * Get all failed transactions for a plugin
   */
  async getFailedTransactions(pluginName: string): Promise<PluginFailedTransaction[]> {
    return this.failedTransactionRepository.find({
      where: { plugin_name: pluginName },
      order: { created_at: 'DESC' },
    });
  }

  /**
   * Check for version mismatches and retry failed transactions
   * This should be called periodically or when plugin versions are updated
   */
  async checkAndRetryVersionMismatches(): Promise<void> {
    try {
      const plugins = this.pluginRegistryService.getPlugins();
      
      for (const plugin of plugins) {
        const syncState = await this.pluginSyncStateRepository.findOne({
          where: { plugin_name: plugin.name },
        });

        if (!syncState) {
          continue;
        }

        const currentVersion = syncState.version;
        
        // Find failed transactions with older versions
        const failedTxs = await this.failedTransactionRepository.find({
          where: {
            plugin_name: plugin.name,
          },
        });

        // Group by version
        const versionGroups = new Map<number, PluginFailedTransaction[]>();
        for (const ftx of failedTxs) {
          if (ftx.version < currentVersion) {
            const group = versionGroups.get(ftx.version) || [];
            group.push(ftx);
            versionGroups.set(ftx.version, group);
          }
        }

        // Retry transactions from older versions
        for (const [oldVersion, transactions] of versionGroups) {
          if (oldVersion < currentVersion) {
            this.logger.log(
              `[${plugin.name}] Found ${transactions.length} failed transactions from version ${oldVersion}, retrying with version ${currentVersion}`,
            );
            await this.retryFailedTransactions(plugin.name, oldVersion, currentVersion);
          }
        }
      }
    } catch (error: any) {
      this.logger.error('Error checking version mismatches', error);
    }
  }
}


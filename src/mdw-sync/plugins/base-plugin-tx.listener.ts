import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Tx } from '../entities/tx.entity';
import { Plugin } from './plugin.interface';
import { BasePluginSyncService } from './base-plugin-sync.service';

export abstract class BasePluginTxListener {
  protected abstract readonly logger: Logger;

  /**
   * Returns the plugin instance
   */
  protected abstract getPlugin(): Plugin;

  /**
   * Returns the sync service instance
   */
  protected abstract getSyncService(): BasePluginSyncService;

  /**
   * Handle transaction created event
   */
  @OnEvent('tx.created', { async: true })
  async handleTxCreated(tx: Tx): Promise<void> {
    try {
      const plugin = this.getPlugin();
      const syncService = this.getSyncService();
      const filters = plugin.filters();

      // Check if transaction matches any of the plugin's filters
      const matches = filters.some((filter) =>
        (syncService as any).matchesFilter(tx, filter),
      );

      if (!matches) {
        return;
      }

      // Process the transaction
      await syncService.processTransaction(tx);
    } catch (error) {
      this.logger.error(
        `Failed to handle transaction ${tx.tx_hash}`,
        error.stack,
      );
    }
  }
}

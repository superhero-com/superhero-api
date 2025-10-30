import { fetchJson } from '@/utils/common';
import { ITransaction } from '@/utils/types';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { DataSource, Repository } from 'typeorm';
import { KeyBlock } from '../entities/key-block.entity';
import { PluginSyncState } from '../entities/plugin-sync-state.entity';
import { SyncState } from '../entities/sync-state.entity';
import { Tx } from '../entities/tx.entity';
import { PluginRegistryService } from './plugin-registry.service';
import { ReorgService } from './reorg.service';

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
    @InjectRepository(SyncState)
    private syncStateRepository: Repository<SyncState>,
    @InjectRepository(PluginSyncState)
    private pluginSyncStateRepository: Repository<PluginSyncState>,
    private pluginRegistry: PluginRegistryService,
    private reorgService: ReorgService,
    private configService: ConfigService,
    private dataSource: DataSource,
  ) {}

  async onModuleInit() {
    await this.initializeSyncState();
    await this.initializePluginSyncStates();
    this.startSync();
  }

  private async initializeSyncState() {
    const existing = await this.syncStateRepository.findOne({
      where: { id: 'global' },
    });

    if (!existing) {
      const middlewareUrl = this.configService.get<string>('mdw.middlewareUrl');
      const status = await fetchJson(`${middlewareUrl}/v3/status`);

      await this.syncStateRepository.save({
        id: 'global',
        last_synced_height: 0,
        last_synced_hash: '',
        tip_height: status.top_block_height,
      });
    }
  }

  private async initializePluginSyncStates() {
    const plugins = this.pluginRegistry.getPlugins();

    for (const plugin of plugins) {
      let existing = await this.pluginSyncStateRepository.findOne({
        where: { plugin_name: plugin.name },
      });

      if (existing && existing.version !== plugin.version) {
        await this.pluginSyncStateRepository.delete({
          plugin_name: plugin.name,
        });
        existing = null;
        // TODO: should send to the plugin all the transactions that were synced before the version change
      }

      if (!existing) {
        await this.pluginSyncStateRepository.save({
          version: plugin.version,
          plugin_name: plugin.name,
          last_synced_height: plugin.startFromHeight() - 1,
          start_from_height: plugin.startFromHeight(),
          is_active: true,
        });
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
      // Check for reorgs first
      const hadReorg = await this.reorgService.detectAndHandleReorg();
      if (hadReorg) {
        this.logger.log('Reorg detected and handled, continuing sync');
      }

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

      if (tipHeight <= syncState.last_synced_height) {
        return; // No new blocks
      }

      // Update tip height
      await this.syncStateRepository.update(
        { id: 'global' },
        { tip_height: tipHeight },
      );

      // Sync new blocks
      const startHeight = syncState.last_synced_height + 1;
      const endHeight = Math.min(
        tipHeight,
        startHeight +
          this.configService.get<number>('mdw.backfillBatchBlocks', 50) -
          1,
      );

      await this.syncBlocks(startHeight, endHeight);
      await this.syncTransactions(startHeight, endHeight);

      // Update sync state
      await this.syncStateRepository.update(
        { id: 'global' },
        {
          last_synced_height: endHeight,
          last_synced_hash: '', // Will be updated when we store the block
        },
      );
    } catch (error) {
      this.logger.error('Sync failed', error);
    } finally {
      this.isRunning = false;
    }
    this.sync();
  }

  private async syncBlocks(startHeight: number, endHeight: number) {
    const middlewareUrl = this.configService.get<string>('mdw.middlewareUrl');

    try {
      // Use batch endpoint to fetch multiple blocks at once
      const limit = Math.min(endHeight - startHeight + 1, 100);
      const scope = `gen:${startHeight}-${endHeight}`;
      let url = `${middlewareUrl}/v3/key-blocks?scope=${scope}&limit=${limit}`;
      const blocksToSave: Partial<KeyBlock>[] = [];

      // Process all pages
      while (url) {
        const response = await fetchJson(url);
        const blocks = response?.data || [];

        // Convert blocks to entity format
        for (const block of blocks) {
          blocksToSave.push({
            height: block.height,
            hash: block.hash,
            parent_hash: block.prev_hash || block.prev_key_hash,
            timestamp: new Date(block.time),
            transactions_count: block.transactions_count,
            micro_blocks_count: block.micro_blocks_count,
            beneficiary_reward: block.beneficiary_reward,
          });
        }

        // Check if there's a next page
        url = response.next ? `${middlewareUrl}${response.next}` : null;
      }

      // Batch save all blocks
      if (blocksToSave.length > 0) {
        await this.blockRepository.save(blocksToSave);
        this.logger.debug(
          `Synced ${blocksToSave.length} blocks (${startHeight}-${endHeight})`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to sync blocks ${startHeight}-${endHeight}`,
        error,
      );
    }
  }

  private async syncTransactions(startHeight: number, endHeight: number) {
    const pageLimit = Math.min(
      this.configService.get<number>('mdw.pageLimit', 100),
      100,
    );
    // sync & save all transactions from startHeight to endHeight
    const middlewareUrl = this.configService.get<string>('mdw.middlewareUrl');

    const queryParams = new URLSearchParams({
      direction: 'forward',
      limit: pageLimit.toString(),
      scope: `gen:${startHeight}-${endHeight}`,
    });

    const url = `${middlewareUrl}/v3/transactions?${queryParams}`;
    await this.processTransactionPage(url);
  }

  private async processTransactionPage(url: string) {
    try {
      const response = await fetchJson(url);
      const transactions = response?.data || [];

      if (transactions.length === 0) {
        return;
      }

      // Convert and filter transactions
      const mdwTxs: Partial<Tx>[] = [];

      for (const tx of transactions) {
        const camelTx = camelcaseKeysDeep(tx) as ITransaction;
        const mdwTx = this.convertToMdwTx(camelTx);
        mdwTxs.push(mdwTx);
      }

      if (mdwTxs.length > 0) {
        // Save transactions
        await this.txRepository.save(mdwTxs);

        const pluginsTx = mdwTxs.filter((tx) => this.matchesAnyPlugin(tx.raw));
        // Dispatch to plugins
        await this.dispatchToPlugins(pluginsTx);
      }

      // Process next page if available
      if (response.next) {
        const nextUrl = `${this.configService.get<string>('mdw.middlewareUrl')}${response.next}`;
        await this.processTransactionPage(nextUrl);
      }
    } catch (error) {
      this.logger.error('Failed to process transaction page', error);
    }
  }

  private matchesAnyPlugin(tx: ITransaction): boolean {
    const plugins = this.pluginRegistry.getPlugins();

    for (const plugin of plugins) {
      const filters = plugin.filters();

      for (const filter of filters) {
        if (this.matchesFilter(tx, filter)) {
          return true;
        }
      }
    }

    return false;
  }

  private matchesFilter(tx: ITransaction, filter: any): boolean {
    // Check type
    if (filter.type && tx.tx?.type !== filter.type) {
      return false;
    }

    // Check contract ID
    if (filter.contractIds && filter.contractIds.length > 0) {
      if (
        !tx.tx?.contractId ||
        !filter.contractIds.includes(tx.tx.contractId)
      ) {
        return false;
      }
    }

    // Check function
    if (filter.functions && filter.functions.length > 0) {
      if (!tx.tx?.function || !filter.functions.includes(tx.tx.function)) {
        return false;
      }
    }

    // Check predicate
    if (filter.predicate) {
      const mdwTx = this.convertToMdwTx(tx);
      return filter.predicate(mdwTx);
    }

    return true;
  }

  private convertToMdwTx(tx: ITransaction): Partial<Tx> {
    return {
      tx_hash: tx.hash,
      block_height: tx.blockHeight,
      block_hash: tx.blockHash?.toString() || '',
      micro_time: tx.microTime?.toString() || '0',
      type: tx.tx?.type || '',
      contract_id: tx.tx?.contractId,
      function: tx.tx?.function,
      caller_id: tx.tx?.callerId,
      sender_id: tx.tx?.senderId,
      recipient_id: tx.tx?.recipientId,
      raw: tx,
    };
  }

  private async dispatchToPlugins(mdwTxs: Partial<Tx>[]) {
    const plugins = this.pluginRegistry.getPlugins();

    for (const plugin of plugins) {
      try {
        // Check if plugin should receive these transactions
        const pluginSyncState = await this.pluginSyncStateRepository.findOne({
          where: { plugin_name: plugin.name },
        });

        if (!pluginSyncState || !pluginSyncState.is_active) {
          continue;
        }

        // Filter transactions for this plugin
        const relevantTxs = mdwTxs.filter((tx) => {
          const filters = plugin.filters();
          return filters.some((filter) => this.matchesFilter(tx.raw, filter));
        });

        if (relevantTxs.length > 0) {
          await plugin.onTransactionsSaved(relevantTxs);

          // Update plugin sync state
          const maxHeight = Math.max(
            ...relevantTxs.map((tx) => tx.block_height),
          );
          await this.pluginSyncStateRepository.update(
            { plugin_name: plugin.name },
            { last_synced_height: maxHeight },
          );
        }
      } catch (error) {
        this.logger.error(
          `Plugin ${plugin.name} failed to process transactions`,
          error,
        );
      }
    }
  }

  async handleLiveTransaction(transaction: ITransaction) {
    try {
      // Check if transaction matches any plugin filters
      if (!this.matchesAnyPlugin(transaction)) {
        return;
      }

      const mdwTx = this.convertToMdwTx(transaction);

      // Save transaction
      await this.txRepository.save(mdwTx);

      // Dispatch to plugins immediately
      await this.dispatchToPlugins([mdwTx]);
    } catch (error) {
      this.logger.error('Failed to handle live transaction', error);
    }
  }

  onModuleDestroy() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }
  }
}

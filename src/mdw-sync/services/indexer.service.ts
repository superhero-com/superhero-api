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
    private reorgService: ReorgService,
    private configService: ConfigService,
    private dataSource: DataSource,
  ) {}

  async onModuleInit() {
    await this.initializeSyncState();
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
        tip_height: status.mdw_height,
      });
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

      // Convert transactions
      const mdwTxs: Partial<Tx>[] = [];

      for (const tx of transactions) {
        const camelTx = camelcaseKeysDeep(tx) as ITransaction;
        const mdwTx = this.convertToMdwTx(camelTx);
        mdwTxs.push(mdwTx);
      }

      if (mdwTxs.length > 0) {
        // Save transactions - TxSubscriber will emit events for plugins
        await this.txRepository.save(mdwTxs);
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

  async handleLiveTransaction(transaction: ITransaction) {
    try {
      const mdwTx = this.convertToMdwTx(transaction);

      // Save transaction - TxSubscriber will emit events for plugins
      await this.txRepository.save(mdwTx);
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

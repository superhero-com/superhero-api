import { fetchJson } from '@/utils/common';
import { ITransaction } from '@/utils/types';
import { decode } from '@aeternity/aepp-sdk';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { Between, DataSource, Repository } from 'typeorm';
import { KeyBlock } from '../entities/key-block.entity';
import { MicroBlock } from '../entities/micro-block.entity';
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
    @InjectRepository(MicroBlock)
    private microBlockRepository: Repository<MicroBlock>,
    @InjectRepository(SyncState)
    private syncStateRepository: Repository<SyncState>,
    @InjectRepository(PluginSyncState)
    private pluginSyncStateRepository: Repository<PluginSyncState>,
    private reorgService: ReorgService,
    private configService: ConfigService,
    private dataSource: DataSource,
    private eventEmitter: EventEmitter2,
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
        is_bulk_mode: false,
      });
    }
  }

  /**
   * Determine if we should use bulk mode based on how far behind we are
   */
  private isBulkMode(lastSyncedHeight: number, tipHeight: number): boolean {
    const threshold = this.configService.get<number>(
      'mdw.bulkModeThreshold',
      100,
    );
    return tipHeight - lastSyncedHeight > threshold;
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

      // Determine sync mode
      const shouldUseBulkMode = this.isBulkMode(
        syncState.last_synced_height,
        tipHeight,
      );

      // Update bulk mode state if it changed
      if (syncState.is_bulk_mode !== shouldUseBulkMode) {
        await this.syncStateRepository.update(
          { id: 'global' },
          { is_bulk_mode: shouldUseBulkMode },
        );

        // Emit event when transitioning from bulk to live mode
        if (syncState.is_bulk_mode && !shouldUseBulkMode) {
          this.logger.log('Transitioning from bulk mode to live mode');
          this.eventEmitter.emit('sync.bulk-complete');
        } else if (!syncState.is_bulk_mode && shouldUseBulkMode) {
          this.logger.log('Entering bulk mode for historical sync');
        }

        // Emit event to invalidate subscriber cache
        this.eventEmitter.emit('sync.bulk-mode-changed');
      }

      // Sync new blocks
      const startHeight = syncState.last_synced_height + 1;
      const batchSize = shouldUseBulkMode
        ? this.configService.get<number>('mdw.bulkModeBatchBlocks', 1000)
        : this.configService.get<number>('mdw.backfillBatchBlocks', 50);

      const endHeight = Math.min(tipHeight, startHeight + batchSize - 1);

      if (shouldUseBulkMode) {
        // Use parallel processing in bulk mode
        await this.syncBlocksParallel(startHeight, endHeight);
      } else {
        // Use sequential processing in live mode
        await this.syncBlocks(startHeight, endHeight);
        await this.syncMicroBlocks(startHeight, endHeight);
        await this.syncTransactions(startHeight, endHeight);
      }

      // Update sync state
      await this.syncStateRepository.update(
        { id: 'global' },
        {
          last_synced_height: endHeight,
          last_synced_hash: '', // Will be updated when we store the block
        },
      );
    } catch (error: any) {
      this.logger.error('Sync failed', error);
    } finally {
      this.isRunning = false;
    }
    this.sync();
  }

  private async syncBlocks(startHeight: number, endHeight: number) {
    const middlewareUrl = this.configService.get<string>('mdw.middlewareUrl');

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
          ...block,
          timestamp: block.time,
          created_at: new Date(block.time),
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
  }

  private async syncMicroBlocks(startHeight: number, endHeight: number) {
    const middlewareUrl = this.configService.get<string>('mdw.middlewareUrl');

    // Get all key-blocks in the height range
    const keyBlocks = await this.blockRepository.find({
      where: {
        height: Between(startHeight, endHeight) as any,
      },
    });

    if (keyBlocks.length === 0) {
      return;
    }

    const microBlocksToSave: Partial<MicroBlock>[] = [];

    // Process key-blocks in parallel batches (3-4 at a time)
    const parallelBatchSize = this.configService.get<number>(
      'mdw.microBlocksParallelBatchSize',
      4,
    );
    for (let i = 0; i < keyBlocks.length; i += parallelBatchSize) {
      const batch = keyBlocks.slice(i, i + parallelBatchSize);

      // Fetch micro-blocks for multiple key-blocks concurrently
      // Use Promise.all to fail fast on any error
      const batchPromises = batch.map((keyBlock) =>
        this.fetchMicroBlocksForKeyBlock(keyBlock, middlewareUrl),
      );

      const batchResults = await Promise.all(batchPromises);

      // Collect results from all batches
      for (const result of batchResults) {
        microBlocksToSave.push(...result);
      }
    }

    // Batch save all micro-blocks (split into smaller batches to avoid PostgreSQL parameter limits)
    if (microBlocksToSave.length > 0) {
      const saveBatchSize = 1000; // Safe batch size for PostgreSQL
      for (let i = 0; i < microBlocksToSave.length; i += saveBatchSize) {
        const batch = microBlocksToSave.slice(i, i + saveBatchSize);
        await this.microBlockRepository.save(batch);
      }
      this.logger.debug(
        `Synced ${microBlocksToSave.length} micro-blocks for ${keyBlocks.length} key-blocks (${startHeight}-${endHeight})`,
      );
    }
  }

  /**
   * Fetch micro-blocks for a single key-block (handles pagination)
   */
  private async fetchMicroBlocksForKeyBlock(
    keyBlock: KeyBlock,
    middlewareUrl: string,
  ): Promise<Partial<MicroBlock>[]> {
    const microBlocksToSave: Partial<MicroBlock>[] = [];

    let microBlocksUrl = `${middlewareUrl}/v3/key-blocks/${keyBlock.hash}/micro-blocks?limit=100`;

    // Handle pagination
    while (microBlocksUrl) {
      const response = await fetchJson(microBlocksUrl);
      const microBlocks = response?.data || [];

      // Convert micro-blocks to entity format
      for (const microBlock of microBlocks) {
        microBlocksToSave.push({
          hash: microBlock.hash,
          height: microBlock.height,
          prev_hash: microBlock.prev_hash,
          prev_key_hash: microBlock.prev_key_hash,
          state_hash: microBlock.state_hash,
          time: microBlock.time.toString(),
          transactions_count: microBlock.transactions_count,
          flags: microBlock.flags,
          version: microBlock.version,
          gas: microBlock.gas,
          micro_block_index: microBlock.micro_block_index,
          pof_hash: microBlock.pof_hash,
          signature: microBlock.signature,
          txs_hash: microBlock.txs_hash,
          created_at: new Date(microBlock.time),
        });
      }

      // Check if there's a next page
      microBlocksUrl = response.next
        ? `${middlewareUrl}${response.next}`
        : null;
    }

    return microBlocksToSave;
  }

  private async syncTransactions(
    startHeight: number,
    endHeight: number,
    useBulkMode = false,
  ) {
    // MDW has a hard limit of 100 transactions per request, regardless of mode
    const pageLimit = Math.min(
      this.configService.get<number>('mdw.pageLimit', 100),
      100, // Hard limit enforced by MDW
    );

    // sync & save all transactions from startHeight to endHeight
    const middlewareUrl = this.configService.get<string>('mdw.middlewareUrl');

    const queryParams = new URLSearchParams({
      direction: 'forward',
      limit: pageLimit.toString(),
      scope: `gen:${startHeight}-${endHeight}`,
    });

    const url = `${middlewareUrl}/v3/transactions?${queryParams}`;
    await this.processTransactionPage(url, useBulkMode);
  }

  private async processTransactionPage(
    url: string,
    useBulkMode = false,
  ): Promise<void> {
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
      if (useBulkMode) {
        // Use bulk insert for better performance
        try {
          await this.bulkInsertTransactions(mdwTxs);
        } catch (error: any) {
          this.logger.error(
            `Bulk insert failed for page, trying repository.save as fallback`,
            error,
          );
          // Fallback to repository.save if bulk insert fails
          await this.txRepository.save(mdwTxs);
        }
      } else {
        // Save transactions - TxSubscriber will emit events for plugins
        await this.txRepository.save(mdwTxs);
      }
    }

    // Process next page if available
    if (response.next) {
      const nextUrl = `${this.configService.get<string>('mdw.middlewareUrl')}${response.next}`;
      await this.processTransactionPage(nextUrl, useBulkMode);
    }
  }

  /**
   * Bulk insert transactions using repository.insert() method
   * Note: repository.insert() bypasses TypeORM subscribers (unlike QueryBuilder.insert())
   */
  private async bulkInsertTransactions(txs: Partial<Tx>[]): Promise<void> {
    if (txs.length === 0) {
      return;
    }

    // repository.insert() bypasses subscribers - this is the correct method
    // Split into batches to avoid SQL parameter limits
    const batchSize = 1000;
    let totalInserted = 0;

    for (let i = 0; i < txs.length; i += batchSize) {
      const batch = txs.slice(i, i + batchSize);

      try {
        // repository.insert() bypasses subscribers - this is documented TypeORM behavior
        const result = await this.txRepository.insert(batch);

        // Count affected rows - insert() returns { identifiers: [], generatedMaps: [] }
        const affected = result.identifiers?.length || batch.length;
        totalInserted += affected;
      } catch (error: any) {
        // Check if it's a duplicate key error (expected with orIgnore equivalent)
        if (error.code === '23505' || error.message?.includes('duplicate')) {
          // Duplicate - this is expected, count as inserted
          totalInserted += batch.length;
          continue;
        }

        this.logger.error(
          `Failed to bulk insert batch ${i + 1}-${Math.min(i + batchSize, txs.length)}: ${error.message}`,
          error.stack || error,
        );
        // Log sample data for debugging
        if (batch.length > 0) {
          this.logger.error(
            `Sample transaction data: ${JSON.stringify(batch[0], null, 2)}`,
          );
        }
        // Re-throw to trigger fallback in processTransactionPage
        throw error;
      }
    }

    this.logger.log(
      `Bulk inserted ${totalInserted} transactions (${txs.length} attempted)`,
    );
  }

  /**
   * Parallel processing of multiple block ranges for bulk sync
   */
  private async syncBlocksParallel(
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

    // Split the range into chunks for parallel processing
    for (let i = startHeight; i <= endHeight; i += batchSize) {
      ranges.push({
        start: i,
        end: Math.min(i + batchSize - 1, endHeight),
      });
    }

    // Process ranges in parallel batches
    for (let i = 0; i < ranges.length; i += parallelWorkers) {
      const batch = ranges.slice(i, i + parallelWorkers);
      await Promise.all(
        batch.map((range) =>
          this.syncBlockRange(range.start, range.end).catch((error: any) => {
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
        `Bulk sync progress: ${completed}/${ranges.length} ranges completed`,
      );
    }
  }

  /**
   * Sync a single block range (blocks, micro-blocks, and transactions)
   */
  private async syncBlockRange(
    startHeight: number,
    endHeight: number,
  ): Promise<void> {
    await this.syncBlocks(startHeight, endHeight);
    await this.syncMicroBlocks(startHeight, endHeight);
    await this.syncTransactions(startHeight, endHeight, true); // Use bulk mode
  }

  private convertToMdwTx(tx: ITransaction): Partial<Tx> {
    let payload = '';
    if (tx?.tx?.type === 'SpendTx' && tx?.tx?.payload) {
      payload = decode(tx?.tx?.payload).toString();
    }
    return {
      hash: tx.hash,
      block_height: tx.blockHeight,
      block_hash: tx.blockHash?.toString() || '',
      micro_index: tx.microIndex?.toString() || '0',
      micro_time: tx.microTime?.toString() || '0',
      signatures: tx.signatures || [],
      encoded_tx: tx.encodedTx || '',
      type: tx.tx?.type || '',
      contract_id: tx.tx?.contractId,
      function: tx.tx?.function,
      caller_id: tx.tx?.callerId,
      sender_id: tx.tx?.senderId,
      recipient_id: tx.tx?.recipientId,
      payload: payload,
      raw: tx.tx,
      version: 1, // Explicitly set default value
      created_at: new Date(tx.microTime), // Explicitly set timestamp
    };
  }

  async handleLiveTransaction(transaction: ITransaction) {
    try {
      const mdwTx = this.convertToMdwTx(transaction);

      // Save transaction - TxSubscriber will emit events for plugins
      await this.txRepository.save(mdwTx);
    } catch (error: any) {
      this.logger.error('Failed to handle live transaction', error);
    }
  }

  onModuleDestroy() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }
  }
}

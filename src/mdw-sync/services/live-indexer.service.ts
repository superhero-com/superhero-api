import { fetchJson } from '@/utils/common';
import { ITransaction } from '@/utils/types';
import { decode } from '@aeternity/aepp-sdk';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { Between, Repository } from 'typeorm';
import { KeyBlock } from '../entities/key-block.entity';
import { MicroBlock } from '../entities/micro-block.entity';
import { SyncState } from '../entities/sync-state.entity';
import { Tx } from '../entities/tx.entity';

@Injectable()
export class LiveIndexerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveIndexerService.name);
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
    private configService: ConfigService,
  ) {}

  async onModuleInit() {
    this.startSync();
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

      // Get current live sync height
      const currentLiveHeight = syncState.live_synced_height ?? 0;

      // Check if there are new blocks to sync
      if (tipHeight <= currentLiveHeight) {
        return; // No new blocks
      }

      // Sync forward: from currentLiveHeight + 1 to tipHeight
      const batchSize = this.configService.get<number>(
        'mdw.backfillBatchBlocks',
        50,
      );

      const startHeight = currentLiveHeight + 1;
      const endHeight = Math.min(tipHeight, startHeight + batchSize - 1);

      // Sync blocks, micro-blocks, and transactions forward
      await this.syncBlocks(startHeight, endHeight);
      await this.syncMicroBlocks(startHeight, endHeight);
      await this.syncTransactions(startHeight, endHeight);

      // Update live sync state (increase live_synced_height as we go forward)
      await this.syncStateRepository.update(
        { id: 'global' },
        {
          live_synced_height: endHeight,
        },
      );

      this.logger.debug(
        `Live sync: synced blocks ${startHeight}-${endHeight}, live_synced_height now ${endHeight}`,
      );
    } catch (error: any) {
      this.logger.error('Live sync failed', error);
    } finally {
      this.isRunning = false;
    }
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
        `Live sync: synced ${blocksToSave.length} blocks (${startHeight}-${endHeight})`,
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
      const batchPromises = batch.map((keyBlock) =>
        this.fetchMicroBlocksForKeyBlock(keyBlock, middlewareUrl),
      );

      const batchResults = await Promise.all(batchPromises);

      // Collect results from all batches
      for (const result of batchResults) {
        microBlocksToSave.push(...result);
      }
    }

    // Batch save all micro-blocks
    if (microBlocksToSave.length > 0) {
      const saveBatchSize = 1000; // Safe batch size for PostgreSQL
      for (let i = 0; i < microBlocksToSave.length; i += saveBatchSize) {
        const batch = microBlocksToSave.slice(i, i + saveBatchSize);
        await this.microBlockRepository.save(batch);
      }
      this.logger.debug(
        `Live sync: synced ${microBlocksToSave.length} micro-blocks for ${keyBlocks.length} key-blocks (${startHeight}-${endHeight})`,
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
  ) {
    // MDW has a hard limit of 100 transactions per request
    const pageLimit = Math.min(
      this.configService.get<number>('mdw.pageLimit', 100),
      100, // Hard limit enforced by MDW
    );

    const middlewareUrl = this.configService.get<string>('mdw.middlewareUrl');

    const queryParams = new URLSearchParams({
      direction: 'forward', // Live sync uses forward direction
      limit: pageLimit.toString(),
      scope: `gen:${startHeight}-${endHeight}`,
    });

    const url = `${middlewareUrl}/v3/transactions?${queryParams}`;
    await this.processTransactionPage(url);
  }

  private async processTransactionPage(url: string): Promise<void> {
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

    // Save transactions - TxSubscriber will emit events for plugins (not in bulk mode)
    if (mdwTxs.length > 0) {
      await this.txRepository.save(mdwTxs);
    }

    // Process next page if available
    if (response.next) {
      const nextUrl = `${this.configService.get<string>('mdw.middlewareUrl')}${response.next}`;
      await this.processTransactionPage(nextUrl);
    }
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
      version: 1,
      created_at: new Date(tx.microTime),
    };
  }

  onModuleDestroy() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }
  }
}


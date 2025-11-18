import { fetchJson, sanitizeJsonForPostgres } from '@/utils/common';
import { ITransaction } from '@/utils/types';
import { decode } from '@aeternity/aepp-sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { Between, Repository, In } from 'typeorm';
import { KeyBlock } from '../entities/key-block.entity';
import { MicroBlock } from '../entities/micro-block.entity';
import { Tx } from '../entities/tx.entity';
import { PluginBatchProcessorService } from './plugin-batch-processor.service';
import { MicroBlockService } from './micro-block.service';
import { SyncDirectionEnum } from '../types/sync-direction';

@Injectable()
export class BlockSyncService {
  private readonly logger = new Logger(BlockSyncService.name);

  constructor(
    @InjectRepository(Tx)
    private txRepository: Repository<Tx>,
    @InjectRepository(KeyBlock)
    private blockRepository: Repository<KeyBlock>,
    @InjectRepository(MicroBlock)
    private microBlockRepository: Repository<MicroBlock>,
    private configService: ConfigService,
    private pluginBatchProcessor: PluginBatchProcessorService,
    private microBlockService: MicroBlockService,
  ) {}

  async syncBlocks(startHeight: number, endHeight: number): Promise<void> {
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

    // Batch upsert all blocks (split into smaller batches to avoid PostgreSQL parameter limits)
    // Using upsert to handle duplicate key violations gracefully during parallel processing
    if (blocksToSave.length > 0) {
      const saveBatchSize = 1000; // Safe batch size for PostgreSQL
      for (let i = 0; i < blocksToSave.length; i += saveBatchSize) {
        const batch = blocksToSave.slice(i, i + saveBatchSize);
        await this.blockRepository.upsert(batch, {
          conflictPaths: ['hash'],
          skipUpdateIfNoValuesChanged: true,
        });
      }
      this.logger.debug(
        `Synced ${blocksToSave.length} blocks (${startHeight}-${endHeight})`,
      );
    }
  }

  async syncMicroBlocks(startHeight: number, endHeight: number): Promise<void> {
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
        this.microBlockService.fetchMicroBlocksForKeyBlock(keyBlock.hash),
      );

      const batchResults = await Promise.all(batchPromises);

      // Collect results from all batches
      for (const result of batchResults) {
        microBlocksToSave.push(...result);
      }
    }

    // Batch upsert all micro-blocks (split into smaller batches to avoid PostgreSQL parameter limits)
    // Using upsert to handle duplicate key violations gracefully during parallel processing
    if (microBlocksToSave.length > 0) {
      const saveBatchSize = 1000; // Safe batch size for PostgreSQL
      for (let i = 0; i < microBlocksToSave.length; i += saveBatchSize) {
        const batch = microBlocksToSave.slice(i, i + saveBatchSize);
        await this.microBlockRepository.upsert(batch, {
          conflictPaths: ['hash'],
          skipUpdateIfNoValuesChanged: true,
        });
      }
      this.logger.debug(
        `Synced ${microBlocksToSave.length} micro-blocks for ${keyBlocks.length} key-blocks (${startHeight}-${endHeight})`,
      );
    }
  }

  async syncTransactions(
    startHeight: number,
    endHeight: number,
    useBulkMode = false,
    backward = false,
  ): Promise<Map<number, string[]>> {
    // MDW has a hard limit of 100 transactions per request, regardless of mode
    const pageLimit = Math.min(
      this.configService.get<number>('mdw.pageLimit', 100),
      100, // Hard limit enforced by MDW
    );

    // sync & save all transactions from startHeight to endHeight
    const middlewareUrl = this.configService.get<string>('mdw.middlewareUrl');

    const queryParams = new URLSearchParams({
      direction: backward ? 'backward' : 'forward',
      limit: pageLimit.toString(),
      scope: `gen:${startHeight}-${endHeight}`,
    });

    const url = `${middlewareUrl}/v3/transactions?${queryParams}`;
    const txHashesByBlock = new Map<number, string[]>();
    await this.processTransactionPage(url, useBulkMode, txHashesByBlock);
    return txHashesByBlock;
  }

  private async processTransactionPage(
    url: string,
    useBulkMode = false,
    txHashesByBlock: Map<number, string[]> = new Map(),
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
      
      // Collect transaction hash grouped by block height
      if (mdwTx.hash && mdwTx.block_height !== undefined) {
        const blockHeight = mdwTx.block_height;
        if (!txHashesByBlock.has(blockHeight)) {
          txHashesByBlock.set(blockHeight, []);
        }
        txHashesByBlock.get(blockHeight)!.push(mdwTx.hash);
      }
    }

    if (mdwTxs.length > 0) {
      let savedTxs: Tx[] = [];
      
      if (useBulkMode) {
        // Use bulk insert for better performance
        // Note: bulkInsertTransactions processes batches internally as they're inserted
        try {
          savedTxs = await this.bulkInsertTransactions(mdwTxs);
        } catch (error: any) {
          this.logger.error(
            `Bulk insert failed for page, trying repository.save as fallback`,
            error,
          );
          // Fallback to repository.save if bulk insert fails
          const saved = await this.txRepository.save(mdwTxs);
          savedTxs = Array.isArray(saved) ? saved : [saved];
          // Process batch for plugins (fallback case)
          if (savedTxs.length > 0) {
            await this.pluginBatchProcessor.processBatch(savedTxs, SyncDirectionEnum.Backward);
          }
        }
      } else {
        // Save transactions
        const saved = await this.txRepository.save(mdwTxs);
        savedTxs = Array.isArray(saved) ? saved : [saved];
        // Process batch for plugins immediately
        if (savedTxs.length > 0) {
          await this.pluginBatchProcessor.processBatch(savedTxs, SyncDirectionEnum.Backward);
        }
      }
    }

    // Process next page if available
    if (response.next) {
      const nextUrl = `${this.configService.get<string>('mdw.middlewareUrl')}${response.next}`;
      await this.processTransactionPage(nextUrl, useBulkMode, txHashesByBlock);
    }
  }

  /**
   * Bulk insert transactions using repository.insert() method
   * Note: repository.insert() bypasses TypeORM subscribers (unlike QueryBuilder.insert())
   * Processes each batch immediately after insertion for plugins
   * Returns the saved transactions fetched from the database
   */
  private async bulkInsertTransactions(txs: Partial<Tx>[]): Promise<Tx[]> {
    if (txs.length === 0) {
      return [];
    }

    // repository.insert() bypasses subscribers - this is the correct method
    // Split into batches to avoid SQL parameter limits
    const batchSize = 1000;
    let totalInserted = 0;
    const allSavedTxs: Tx[] = [];

    for (let i = 0; i < txs.length; i += batchSize) {
      const batch = txs.slice(i, i + batchSize);

      try {
        // repository.insert() bypasses subscribers - this is documented TypeORM behavior
        const result = await this.txRepository.insert(batch);

        // Count affected rows - insert() returns { identifiers: [], generatedMaps: [] }
        const affected = result.identifiers?.length || batch.length;
        totalInserted += affected;
        
        // Collect hashes of inserted transactions
        const batchHashes = batch
          .map((tx) => tx.hash)
          .filter(Boolean) as string[];

        // Fetch this batch immediately after insertion
        if (batchHashes.length > 0) {
          const savedBatchTxs = await this.txRepository.find({
            where: { hash: In(batchHashes) },
          });

          // Process batch for plugins immediately (don't wait for full run)
          if (savedBatchTxs.length > 0) {
            // Process immediately - await to ensure batch is processed before next batch
            await this.pluginBatchProcessor.processBatch(savedBatchTxs, SyncDirectionEnum.Backward);

            // Collect for return value
            allSavedTxs.push(...savedBatchTxs);
          }
        }
      } catch (error: any) {
        // Check if it's a duplicate key error (expected with orIgnore equivalent)
        if (error.code === '23505' || error.message?.includes('duplicate')) {
          // Duplicate - this is expected, count as inserted
          totalInserted += batch.length;
          
          // Fetch duplicates and process them
          const batchHashes = batch
            .map((tx) => tx.hash)
            .filter(Boolean) as string[];
          
          if (batchHashes.length > 0) {
            const savedBatchTxs = await this.txRepository.find({
              where: { hash: In(batchHashes) },
            });

            // Process batch for plugins immediately
            if (savedBatchTxs.length > 0) {
              await this.pluginBatchProcessor.processBatch(savedBatchTxs, SyncDirectionEnum.Backward);

              allSavedTxs.push(...savedBatchTxs);
            }
          }
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
      `Bulk inserted ${totalInserted} transactions (${txs.length} attempted), processed ${allSavedTxs.length} for plugins`,
    );

    return allSavedTxs;
  }

  /**
   * Sync a single block range (blocks, micro-blocks, and transactions)
   * Returns a Map of block heights to transaction hashes that were synced
   */
  async syncBlockRange(
    startHeight: number,
    endHeight: number,
    backward = false,
  ): Promise<Map<number, string[]>> {
    await this.syncBlocks(startHeight, endHeight);
    await this.syncMicroBlocks(startHeight, endHeight);
    const txHashesByBlock = await this.syncTransactions(startHeight, endHeight, true, backward); // Use bulk mode
    return txHashesByBlock;
  }

  convertToMdwTx(tx: ITransaction): Partial<Tx> {
    let payload = '';
    if (tx?.tx?.type === 'SpendTx' && tx?.tx?.payload) {
      payload = decode(tx?.tx?.payload).toString();
    }
    
    // Sanitize JSONB fields to remove null bytes and invalid Unicode characters
    // PostgreSQL cannot handle null bytes (\u0000) in JSONB columns
    const sanitizedRaw = tx.tx ? sanitizeJsonForPostgres(tx.tx) : null;
    const sanitizedSignatures = tx.signatures ? sanitizeJsonForPostgres(tx.signatures) : [];
    
    return {
      hash: tx.hash,
      block_height: tx.blockHeight,
      block_hash: tx.blockHash?.toString() || '',
      micro_index: tx.microIndex?.toString() || '0',
      micro_time: tx.microTime?.toString() || '0',
      signatures: sanitizedSignatures,
      encoded_tx: tx.encodedTx || '',
      type: tx.tx?.type || '',
      contract_id: tx.tx?.contractId,
      function: tx.tx?.function,
      caller_id: tx.tx?.callerId,
      sender_id: tx.tx?.senderId,
      recipient_id: tx.tx?.recipientId,
      payload: payload ? sanitizeJsonForPostgres(payload) : '',
      raw: sanitizedRaw,
      version: 1, // Explicitly set default value
      created_at: new Date(tx.microTime), // Explicitly set timestamp
    };
  }
}


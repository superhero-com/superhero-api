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
        blocksToSave.push(this.normalizeKeyBlock(block));
      }

      // Check if there's a next page
      url = response.next ? `${middlewareUrl}${response.next}` : null;
    }

    // Batch upsert all blocks (split into smaller batches to avoid PostgreSQL parameter limits)
    // Using upsert to handle duplicate key violations gracefully during parallel processing
    // Using 'height' as conflict path since it has a unique constraint and each height should map to one block
    if (blocksToSave.length > 0) {
      const saveBatchSize = 1000; // Safe batch size for PostgreSQL
      for (let i = 0; i < blocksToSave.length; i += saveBatchSize) {
        const batch = blocksToSave.slice(i, i + saveBatchSize);
        await this.blockRepository.upsert(batch, {
          conflictPaths: ['height'],
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
    return this.processTransactionPage(url, useBulkMode, txHashesByBlock);
  }

  private async processTransactionPage(
    url: string,
    useBulkMode = false,
    txHashesByBlock: Map<number, string[]> = new Map(),
  ): Promise<Map<number, string[]>> {
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

      // Collect transaction hashes ONLY after successful save
      // This ensures we only track transactions that are actually in the database
      for (const savedTx of savedTxs) {
        if (savedTx.hash && savedTx.block_height !== undefined) {
          const blockHeight = savedTx.block_height;
          if (!txHashesByBlock.has(blockHeight)) {
            txHashesByBlock.set(blockHeight, []);
          }
          txHashesByBlock.get(blockHeight)!.push(savedTx.hash);
        }
      }

      // Log warning if some transactions failed to save
      if (savedTxs.length < mdwTxs.length) {
        const savedHashes = new Set(savedTxs.map(tx => tx.hash).filter(Boolean));
        const failedTxs = mdwTxs.filter(tx => tx.hash && !savedHashes.has(tx.hash));
        this.logger.warn(
          `Only ${savedTxs.length} of ${mdwTxs.length} transactions were saved. ` +
          `Failed hashes: ${failedTxs.map(tx => tx.hash).join(', ')}`
        );
      }
    }

    // Process next page if available
    if (response.next) {
      const nextUrl = `${this.configService.get<string>('mdw.middlewareUrl')}${response.next}`;
      await this.processTransactionPage(nextUrl, useBulkMode, txHashesByBlock);
    }
    return txHashesByBlock;
  }

  /**
   * Bulk insert transactions using repository.upsert() method
   * Note: Using upsert to handle duplicates gracefully during parallel processing
   * Processes each batch immediately after insertion for plugins
   * Returns the saved transactions fetched from the database
   */
  private async bulkInsertTransactions(txs: Partial<Tx>[]): Promise<Tx[]> {
    if (txs.length === 0) {
      return [];
    }

    // Split into batches to avoid SQL parameter limits
    const batchSize = 500;
    const allSavedTxs: Tx[] = [];

    for (let i = 0; i < txs.length; i += batchSize) {
      const batch = txs.slice(i, i + batchSize);

      try {
        // Use upsert to handle duplicates gracefully during parallel processing
        // This ensures transactions are inserted even if they already exist
        // Note: skipUpdateIfNoValuesChanged is not used because it causes PostgreSQL errors
        // when comparing JSONB columns (operator does not exist: jsonb = jsonb)
        await this.txRepository.upsert(batch, {
          conflictPaths: ['hash'],
        });
        
        // Collect hashes of transactions to fetch
        const batchHashes = batch
          .map((tx) => tx.hash)
          .filter(Boolean) as string[];

        // Fetch this batch immediately after upsert to verify they exist
        if (batchHashes.length > 0) {
          const savedBatchTxs = await this.txRepository.find({
            where: { hash: In(batchHashes) },
          });

          // Log warning if some transactions weren't found after upsert
          if (savedBatchTxs.length < batchHashes.length) {
            const savedHashes = new Set(savedBatchTxs.map(tx => tx.hash));
            const missingHashes = batchHashes.filter(hash => !savedHashes.has(hash));
            this.logger.warn(
              `After upsert, only ${savedBatchTxs.length} of ${batchHashes.length} transactions found in database. ` +
              `Missing hashes: ${missingHashes.slice(0, 10).join(', ')}${missingHashes.length > 10 ? '...' : ''}`
            );
          }

          // Process batch for plugins immediately (don't wait for full run)
          if (savedBatchTxs.length > 0) {
            // Process immediately - await to ensure batch is processed before next batch
            await this.pluginBatchProcessor.processBatch(savedBatchTxs, SyncDirectionEnum.Backward);

            // Collect for return value
            allSavedTxs.push(...savedBatchTxs);
          }
        }
      } catch (error: any) {
        this.logger.error(
          `Failed to bulk upsert batch ${i + 1}-${Math.min(i + batchSize, txs.length)}: ${error.message}`,
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
      `Bulk upserted ${txs.length} transactions, processed ${allSavedTxs.length} for plugins`,
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

  private normalizeKeyBlock(block: any): Partial<KeyBlock> {
    return {
      ...block,
      nonce: block?.nonce?.toString() || '0',
      pow: Array.isArray(block?.pow) ? block.pow : [],
      created_at: new Date(block.time),
    };
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


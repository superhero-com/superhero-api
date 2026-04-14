import { fetchJson, sanitizeJsonForPostgres } from '@/utils/common';
import {
  isDatabaseConnectionOrPoolError,
  logDatabaseIssue,
  runWithDatabaseIssueLogging,
} from '@/utils/database-issue-logging';
import { ITransaction } from '@/utils/types';
import { decode } from '@aeternity/aepp-sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { Between, In, Repository } from 'typeorm';
import { KeyBlock } from '../entities/key-block.entity';
import { MicroBlock } from '../entities/micro-block.entity';
import { Tx } from '../entities/tx.entity';
import { PluginBatchProcessorService } from './plugin-batch-processor.service';
import { MicroBlockService } from './micro-block.service';
import { SyncDirectionEnum } from '../types/sync-direction';
import { isSelfTransferTx } from '../utils/common';

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
        await runWithDatabaseIssueLogging({
          logger: this.logger,
          stage: 'key-block upsert',
          context: {
            startHeight,
            endHeight,
            batchStart: i,
            batchSize: batch.length,
          },
          operation: () =>
            this.blockRepository.upsert(batch, {
              conflictPaths: ['height'],
            }),
        });
      }
      this.logger.debug(
        `Synced ${blocksToSave.length} blocks (${startHeight}-${endHeight})`,
      );
    }
  }

  async syncMicroBlocks(startHeight: number, endHeight: number): Promise<void> {
    // Get all key-blocks in the height range
    const keyBlocks = await runWithDatabaseIssueLogging({
      logger: this.logger,
      stage: 'key-block lookup for micro-block sync',
      context: {
        startHeight,
        endHeight,
      },
      operation: () =>
        this.blockRepository.find({
          where: {
            height: Between(startHeight, endHeight) as any,
          },
        }),
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
        await runWithDatabaseIssueLogging({
          logger: this.logger,
          stage: 'micro-block upsert',
          context: {
            startHeight,
            endHeight,
            keyBlockCount: keyBlocks.length,
            batchStart: i,
            batchSize: batch.length,
          },
          operation: () =>
            this.microBlockRepository.upsert(batch, {
              conflictPaths: ['hash'],
              skipUpdateIfNoValuesChanged: true,
            }),
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
    collectHashes = true,
  ): Promise<Map<number, string[]>> {
    const pageLimit = Math.min(
      this.configService.get<number>('mdw.pageLimit', 100),
      100,
    );

    const middlewareUrl = this.configService.get<string>('mdw.middlewareUrl');

    const queryParams = new URLSearchParams({
      direction: backward ? 'backward' : 'forward',
      limit: pageLimit.toString(),
      scope: `gen:${startHeight}-${endHeight}`,
    });

    const url = `${middlewareUrl}/v3/transactions?${queryParams}`;
    const txHashesByBlock = collectHashes ? new Map<number, string[]>() : null;
    return this.processTransactionPage(url, useBulkMode, txHashesByBlock);
  }

  private async processTransactionPage(
    url: string,
    useBulkMode = false,
    txHashesByBlock: Map<number, string[]> | null = new Map(),
  ): Promise<Map<number, string[]>> {
    let nextUrl: string | null = url;
    const middlewareUrl = this.configService.get<string>('mdw.middlewareUrl');

    while (nextUrl) {
      const response = await fetchJson(nextUrl);
      const transactions = response?.data || [];

      if (transactions.length === 0) {
        break;
      }

      const mdwTxs: Partial<Tx>[] = [];
      for (const tx of transactions) {
        const camelTx = camelcaseKeysDeep(tx) as ITransaction;
        if (isSelfTransferTx(camelTx)) {
          continue;
        }
        mdwTxs.push(this.convertToMdwTx(camelTx));
      }

      if (mdwTxs.length > 0) {
        let savedTxs: Partial<Tx>[] = [];

        if (useBulkMode) {
          try {
            savedTxs = await this.bulkInsertTransactions(mdwTxs);
          } catch (error: any) {
            if (isDatabaseConnectionOrPoolError(error)) {
              logDatabaseIssue({
                logger: this.logger,
                stage: 'transaction bulk upsert',
                error,
                context: {
                  url: nextUrl,
                  transactionCount: mdwTxs.length,
                  useBulkMode,
                },
              });
              throw error;
            }

            this.logger.error(
              `Bulk insert failed for page, trying repository.save as fallback`,
              error,
            );
            const saved = await this.txRepository.save(mdwTxs);
            const savedArr = Array.isArray(saved) ? saved : [saved];
            if (savedArr.length > 0) {
              await this.pluginBatchProcessor.processBatch(
                savedArr,
                SyncDirectionEnum.Backward,
              );
            }
            savedTxs = savedArr;
          }
        } else {
          const saved = await runWithDatabaseIssueLogging({
            logger: this.logger,
            stage: 'transaction save',
            context: {
              url: nextUrl,
              transactionCount: mdwTxs.length,
              useBulkMode,
            },
            operation: () => this.txRepository.save(mdwTxs),
          });
          const savedArr = Array.isArray(saved) ? saved : [saved];
          if (savedArr.length > 0) {
            await this.pluginBatchProcessor.processBatch(
              savedArr,
              SyncDirectionEnum.Backward,
            );
          }
          savedTxs = savedArr;
        }

        if (txHashesByBlock) {
          for (const savedTx of savedTxs) {
            if (savedTx.hash && savedTx.block_height !== undefined) {
              const blockHeight = savedTx.block_height;
              if (!txHashesByBlock.has(blockHeight)) {
                txHashesByBlock.set(blockHeight, []);
              }
              txHashesByBlock.get(blockHeight)!.push(savedTx.hash);
            }
          }
        }
      }

      nextUrl = response.next ? `${middlewareUrl}${response.next}` : null;
    }

    return txHashesByBlock ?? new Map();
  }

  /**
   * Bulk insert transactions using repository.upsert() method.
   * Processes each batch immediately after insertion for plugins.
   * Returns the successfully upserted partials (no DB re-read) so callers
   * can extract hash/block_height without doubling heap usage.
   */
  private async bulkInsertTransactions(
    txs: Partial<Tx>[],
  ): Promise<Partial<Tx>[]> {
    if (txs.length === 0) {
      return [];
    }

    const batchSize = 500;
    const accepted: Partial<Tx>[] = [];

    for (let i = 0; i < txs.length; i += batchSize) {
      const batch = txs.slice(i, i + batchSize);

      try {
        await this.txRepository.upsert(batch, {
          conflictPaths: ['hash'],
        });

        const batchHashes = batch
          .map((tx) => tx.hash)
          .filter(Boolean) as string[];

        if (batchHashes.length > 0) {
          const existing = await this.txRepository.find({
            select: ['hash', 'logs', 'data'],
            where: { hash: In(batchHashes) },
          });
          const pluginDataByHash = new Map(
            existing.map((t) => [t.hash, { logs: t.logs, data: t.data }]),
          );

          for (const tx of batch) {
            if (tx.hash) {
              const dbFields = pluginDataByHash.get(tx.hash);
              if (dbFields) {
                tx.logs = dbFields.logs;
                tx.data = dbFields.data;
              }
            }
          }

          await this.pluginBatchProcessor.processBatch(
            batch.filter((tx) => tx.hash) as Tx[],
            SyncDirectionEnum.Backward,
          );
        }

        accepted.push(...batch);
      } catch (error: any) {
        if (isDatabaseConnectionOrPoolError(error)) {
          logDatabaseIssue({
            logger: this.logger,
            stage: 'transaction bulk upsert batch',
            error,
            context: {
              batchStart: i,
              batchEnd: Math.min(i + batchSize, txs.length),
              batchSize: batch.length,
            },
          });
          throw error;
        }
        this.logger.error(
          `Failed to bulk upsert batch ${i + 1}-${Math.min(i + batchSize, txs.length)}: ${error.message}`,
          error.stack || error,
        );
        throw error;
      }
    }

    this.logger.log(
      `Bulk upserted ${txs.length} transactions, processed ${accepted.length} for plugins`,
    );

    return accepted;
  }

  /**
   * Sync a single block range (blocks, micro-blocks, and transactions)
   * Returns a Map of block heights to transaction hashes that were synced
   */
  async syncBlockRange(
    startHeight: number,
    endHeight: number,
    backward = false,
    collectHashes = !backward,
  ): Promise<Map<number, string[]>> {
    await this.syncBlocks(startHeight, endHeight);
    await this.syncMicroBlocks(startHeight, endHeight);
    return this.syncTransactions(
      startHeight,
      endHeight,
      true,
      backward,
      collectHashes,
    );
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
    const sanitizedSignatures = tx.signatures
      ? sanitizeJsonForPostgres(tx.signatures)
      : [];

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

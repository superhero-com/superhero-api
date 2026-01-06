import { fetchJson, sanitizeJsonForPostgres } from '@/utils/common';
import { ITransaction, ITopHeader } from '@/utils/types';
import { decode } from '@aeternity/aepp-sdk';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { Repository } from 'typeorm';
import { KeyBlock } from '../entities/key-block.entity';
import { MicroBlock } from '../entities/micro-block.entity';
import { SyncState } from '../entities/sync-state.entity';
import { Tx } from '../entities/tx.entity';
import { WebSocketService } from '@/ae/websocket.service';
import { PluginBatchProcessorService } from './plugin-batch-processor.service';
import { MicroBlockService } from './micro-block.service';
import { SyncDirectionEnum } from '../types/sync-direction';
import { isSelfTransferTx } from '../utils/common';

@Injectable()
export class LiveIndexerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveIndexerService.name);
  private syncedTransactions: string[] = [];
  private unsubscribeTransactions: (() => void) | null = null;
  private unsubscribeKeyBlocks: (() => void) | null = null;

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
    private websocketService: WebSocketService,
    private pluginBatchProcessor: PluginBatchProcessorService,
    private microBlockService: MicroBlockService,
  ) { }

  async onModuleInit() {
    this.setupWebsocketSubscriptions();
  }

  private setupWebsocketSubscriptions() {
    // Subscribe to transaction updates
    this.unsubscribeTransactions = this.websocketService.subscribeForTransactionsUpdates(
      (transaction: ITransaction) => {
        // ignore self transfer transactions
        if (isSelfTransferTx(transaction)) {
          return;
        }
        // Prevent duplicate transactions
        if (!this.syncedTransactions.includes(transaction.hash)) {
          this.handleLiveTransaction(transaction);
          this.syncedTransactions.push(transaction.hash);

          // Reset synced transactions after 100 transactions
          if (this.syncedTransactions.length > 100) {
            this.syncedTransactions = [];
          }
        }
      },
    );

    // Subscribe to key block updates
    this.unsubscribeKeyBlocks = this.websocketService.subscribeForKeyBlocksUpdates(
      (keyBlockHeader: ITopHeader) => {
        this.handleKeyBlock(keyBlockHeader);
      },
    );

    this.logger.log('Websocket subscriptions established for live indexing');
  }

  async handleLiveTransaction(transaction: ITransaction) {
    try {
      const mdwTx = this.convertToMdwTx(transaction);

      // Save transaction
      const savedTx = await this.txRepository.save(mdwTx);

      // Process batch for plugins (single tx in array) - live sync
      await this.pluginBatchProcessor.processBatch([savedTx], SyncDirectionEnum.Live);

      this.logger.debug(`Live sync: saved transaction ${transaction.hash}`);
    } catch (error: any) {
      this.logger.error('Failed to handle live transaction', error);
    }
  }


  async handleKeyBlock(keyBlockHeader: ITopHeader) {
    try {
      const middlewareUrl = this.configService.get<string>('mdw.middlewareUrl');

      // Fetch full key block details from MDW
      const fullBlock = await fetchJson(
        `${middlewareUrl}/v3/key-blocks/${keyBlockHeader.hash}`,
      );

      // Convert to entity format
      const blockToSave: Partial<KeyBlock> = {
        ...fullBlock,
        created_at: new Date(fullBlock.time),
      };

      // Upsert the key block to handle duplicate key violations gracefully
      try {
        await this.blockRepository.save(blockToSave);
      } catch (error: any) {
        this.logger.error(`Failed to save key block: ${blockToSave.height} ${blockToSave.hash}`, error.stack);
      }

      // Update live_synced_height
      await this.syncStateRepository.update(
        { id: 'global' },
        {
          live_synced_height: keyBlockHeader.height,
          tip_height: keyBlockHeader.height,
        },
      );

      // Fetch and save micro-blocks for this key block
      await this.fetchAndSaveMicroBlocks(keyBlockHeader.hash, middlewareUrl);

      this.logger.debug(
        `Live sync: saved key block ${keyBlockHeader.hash} at height ${keyBlockHeader.height}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to handle key block ${keyBlockHeader.hash}`,
        error,
      );
    }
  }

  private async fetchAndSaveMicroBlocks(
    keyBlockHash: string,
    middlewareUrl: string,
  ): Promise<void> {
    try {
      const microBlocks = await this.microBlockService.fetchMicroBlocksForKeyBlock(
        keyBlockHash,
      );

      if (microBlocks.length > 0) {
        try {
          await this.microBlockRepository.save(microBlocks);
        } catch (error: any) {
          this.logger.error(`Failed to save micro-blocks: ${microBlocks.map(microBlock => microBlock.hash).join(', ')}`, error.stack);
        }
        this.logger.debug(
          `Live sync: saved ${microBlocks.length} micro-blocks for key block ${keyBlockHash}`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch micro-blocks for key block ${keyBlockHash}`,
        error,
      );
    }
  }


  private convertToMdwTx(tx: ITransaction): Partial<Tx> {
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
      version: 1,
      created_at: new Date(tx.microTime),
    };
  }

  /**
   * Get whether the live indexer is active (websocket subscriptions are established)
   */
  getIsActive(): boolean {
    return this.unsubscribeTransactions !== null && this.unsubscribeKeyBlocks !== null;
  }

  onModuleDestroy() {
    // Unsubscribe from websocket channels
    if (this.unsubscribeTransactions) {
      this.unsubscribeTransactions();
    }
    if (this.unsubscribeKeyBlocks) {
      this.unsubscribeKeyBlocks();
    }
  }
}


import { fetchJson } from '@/utils/common';
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
  ) {}

  async onModuleInit() {
    this.setupWebsocketSubscriptions();
  }

  private setupWebsocketSubscriptions() {
    // Subscribe to transaction updates
    this.unsubscribeTransactions = this.websocketService.subscribeForTransactionsUpdates(
      (transaction: ITransaction) => {
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

      // Process batch for plugins (single tx in array)
      await this.pluginBatchProcessor.processBatch([savedTx]);
      
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

      // Save the key block
      await this.blockRepository.save(blockToSave);

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
      const microBlocks = await this.fetchMicroBlocksForKeyBlock(
        { hash: keyBlockHash } as KeyBlock,
        middlewareUrl,
      );

      if (microBlocks.length > 0) {
        await this.microBlockRepository.save(microBlocks);
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
    // Unsubscribe from websocket channels
    if (this.unsubscribeTransactions) {
      this.unsubscribeTransactions();
    }
    if (this.unsubscribeKeyBlocks) {
      this.unsubscribeKeyBlocks();
    }
  }
}


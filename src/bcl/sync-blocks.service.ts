import { AeSdkService } from '@/ae/ae-sdk.service';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { WebSocketService } from '@/ae/websocket.service';
import { TransactionService } from '@/transactions/services/transaction.service';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SyncedBlock } from './entities/synced-block.entity';
import { SyncTransactionsService } from './sync-transactions.service';

@Injectable()
export class SyncBlocksService {
  syncing = false;
  lastSyncedBlockNumber = 0;
  remainingBlocksToSync = 0;
  private readonly logger = new Logger(SyncBlocksService.name);

  constructor(
    private communityFactoryService: CommunityFactoryService,
    private syncTransactionsService: SyncTransactionsService,

    @InjectRepository(SyncedBlock)
    private syncedBlocksRepository: Repository<SyncedBlock>,

    private websocketService: WebSocketService,
    private readonly aeSdkService: AeSdkService,
    private readonly transactionService: TransactionService,
  ) {
    this.syncBlocks();
  }

  async syncBlocks() {
    this.syncing = true;
    const factory = await this.communityFactoryService.getCurrentFactory();
    const firstBlockNumber = factory.block_number;

    const currentBlockNumber = (
      await this.aeSdkService.sdk.getCurrentGeneration()
    ).keyBlock.height;

    const latestSyncedBlock = await this.syncedBlocksRepository.findOne({
      where: {},
      order: {
        block_number: 'DESC',
      },
    });

    const latestSyncedBlockNumber =
      latestSyncedBlock?.block_number || firstBlockNumber;

    this.logger.log(
      `Syncing blocks from ${latestSyncedBlockNumber} to ${currentBlockNumber}`,
    );

    for (
      let blockNumber = latestSyncedBlockNumber;
      blockNumber < currentBlockNumber;
      blockNumber++
    ) {
      this.logger.log(`Syncing block ${blockNumber}`);
      const transactionsHashes =
        await this.syncTransactionsService.syncBlockTransactions(blockNumber);
      this.lastSyncedBlockNumber = blockNumber;
      this.remainingBlocksToSync = currentBlockNumber - blockNumber;
      await this.syncedBlocksRepository.save({
        block_number: blockNumber,
        total_bcl_transactions: transactionsHashes.length,
        synced_tx_hashes: transactionsHashes,
      });
    }
    this.syncing = false;
  }
}

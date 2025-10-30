import { AeSdkService } from '@/ae/ae-sdk.service';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import {
  LIVE_SYNCING_ENABLED,
  PERIODIC_SYNCING_ENABLED,
  TOTAL_BLOCKS_TO_SYNC_EVERY_10_MINUTES,
  TOTAL_BLOCKS_TO_SYNC_EVERY_MINUTE,
} from '@/configs/constants';
import { ACTIVE_NETWORK } from '@/configs/network';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SyncedBlock } from '../entities/synced-block.entity';
import { FixHoldersService } from './fix-holders.service';
import { SyncTransactionsService } from './sync-transactions.service';
import { TransactionService } from './transaction.service';

@Injectable()
export class SyncBlocksService {
  fullSyncing = false;
  syncingLatestBlocks = false;
  currentBlockNumber = 0;
  lastSyncedBlockNumber = 0;
  remainingBlocksToSync = 0;
  bclBlockNumber = 0;
  private readonly logger = new Logger(SyncBlocksService.name);

  constructor(
    private communityFactoryService: CommunityFactoryService,
    private syncTransactionsService: SyncTransactionsService,

    @InjectRepository(SyncedBlock)
    private syncedBlocksRepository: Repository<SyncedBlock>,

    private readonly aeSdkService: AeSdkService,
    private readonly transactionService: TransactionService,

    private fixHoldersService: FixHoldersService,
  ) {
    //
  }

  onModuleInit() {
    this.doFullBlockSync();
  }

  latestBlockNumber = 0;
  totalTicks = 0;
  @Cron(CronExpression.EVERY_MINUTE)
  async syncLatestBlocks() {
    if (!LIVE_SYNCING_ENABLED) {
      return;
    }
    if (this.syncingLatestBlocks) {
      return;
    }
    this.syncingLatestBlocks = true;
    this.logger.log(`syncTransactions::: ${this.latestBlockNumber}`);

    const result = await this.validateBlocksRange(
      TOTAL_BLOCKS_TO_SYNC_EVERY_MINUTE,
    );
    if (result.callers.length > 0) {
      await this.fixHoldersService.syncLatestBlockCallers(result.callers);
    }
    this.syncingLatestBlocks = false;
  }

  syncingPastBlocks = false;
  @Cron(CronExpression.EVERY_10_MINUTES)
  async syncPast100Blocks() {
    if (!PERIODIC_SYNCING_ENABLED) {
      return;
    }
    if (this.syncingPastBlocks) {
      return;
    }
    this.syncingPastBlocks = true;
    await this.validateBlocksRange(TOTAL_BLOCKS_TO_SYNC_EVERY_10_MINUTES);
    this.syncingPastBlocks = false;
  }

  private async validateBlocksRange(range = 10): Promise<{
    callers: string[];
    validated_hashes: string[];
  }> {
    const result = {
      callers: [],
      validated_hashes: [],
    };
    try {
      this.currentBlockNumber = (
        await this.aeSdkService.sdk.getCurrentGeneration()
      ).keyBlock.height;

      this.logger.log('currentGeneration', this.currentBlockNumber);

      this.latestBlockNumber = this.currentBlockNumber;
      this.logger.log('latestBlockNumber', this.latestBlockNumber);
      const fromBlockNumber = this.latestBlockNumber - range;
      for (let i = fromBlockNumber; i <= this.latestBlockNumber; i++) {
        const syncResult = await this.syncBlockTransactions(i);
        syncResult.callers.forEach((caller) => {
          if (!result.callers.includes(caller)) {
            result.callers.push(caller);
          }
        });
        syncResult.validated_hashes.forEach((hash) => {
          if (!result.validated_hashes.includes(hash)) {
            result.validated_hashes.push(hash);
          }
        });
      }
    } catch (error: any) {
      this.logger.error(
        `SyncTransactionsService->Failed to sync transactions`,
        error.stack,
      );
    }
    return result;
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async doFullBlockSync() {
    if (!PERIODIC_SYNCING_ENABLED) {
      return;
    }
    if (this.fullSyncing) {
      return;
    }
    this.fullSyncing = true;
    const factory = await this.communityFactoryService.getCurrentFactory();
    this.bclBlockNumber = factory.deployed_at_block_height;

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
      latestSyncedBlock?.block_number || this.bclBlockNumber;

    this.logger.log(
      `Syncing blocks from ${latestSyncedBlockNumber} to ${currentBlockNumber}`,
    );

    for (
      let blockNumber = latestSyncedBlockNumber;
      blockNumber < currentBlockNumber;
      blockNumber++
    ) {
      this.logger.log(`Syncing block ${blockNumber}`);
      const result = await this.syncBlockTransactions(blockNumber);
      this.lastSyncedBlockNumber = blockNumber;
      this.remainingBlocksToSync = currentBlockNumber - blockNumber;
      await this.syncedBlocksRepository.save({
        block_number: blockNumber,
        total_bcl_transactions: result.validated_hashes.length,
        synced_tx_hashes: result.validated_hashes,
        callers: result.callers,
      });
    }
    this.fullSyncing = false;
  }

  async syncBlockTransactions(blockNumber: number): Promise<{
    validated_hashes: string[];
    callers: string[];
  }> {
    this.logger.log('syncBlockTransactions', blockNumber);
    const queryString = new URLSearchParams({
      direction: 'forward',
      limit: '100',
      scope: `gen:${blockNumber}`,
      type: 'contract_call',
    }).toString();
    const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions?${queryString}`;
    const result =
      await this.syncTransactionsService.fetchAndSyncTransactions(url);
    this.logger.log(
      `syncBlockTransactions->transactionsHashes:`,
      result.validated_hashes,
    );
    if (result.validated_hashes.length > 0) {
      await this.transactionService.deleteNonValidTransactionsInBlock(
        blockNumber,
        result.validated_hashes,
      );
    }
    return result;
  }
}

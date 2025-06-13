import { AeSdkService } from '@/ae/ae-sdk.service';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SyncedBlock } from '../entities/synced-block.entity';
import { SyncTransactionsService } from './sync-transactions.service';
import { ACTIVE_NETWORK } from '@/configs/network';
import { TransactionService } from '@/transactions/services/transaction.service';

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
  ) {
    // this.doFullBlockSync();
  }

  latestBlockNumber = 0;
  totalTicks = 0;
  @Cron(CronExpression.EVERY_30_SECONDS)
  async syncLatestBlocks() {
    if (this.syncingLatestBlocks) {
      return;
    }
    this.syncingLatestBlocks = true;
    this.logger.log(`syncTransactions::: ${this.latestBlockNumber}`);

    try {
      this.currentBlockNumber = (
        await this.aeSdkService.sdk.getCurrentGeneration()
      ).keyBlock.height;

      this.logger.log('currentGeneration', this.currentBlockNumber);
      if (this.currentBlockNumber <= this.latestBlockNumber) {
        this.totalTicks++;
        if (this.totalTicks > 3) {
          await this.syncBlockTransactions(this.currentBlockNumber);
          this.totalTicks = 0;
        }
        this.logger.log('latestBlockNumber is not updated');
        return;
      }
      this.latestBlockNumber = this.currentBlockNumber;
      this.logger.log('latestBlockNumber', this.latestBlockNumber);
      const fromBlockNumber = this.latestBlockNumber - 10;
      for (let i = fromBlockNumber; i <= this.latestBlockNumber; i++) {
        await this.syncBlockTransactions(i);
      }
    } catch (error: any) {
      this.logger.error(
        `SyncTransactionsService->Failed to sync transactions`,
        error.stack,
      );
    } finally {
      this.syncingLatestBlocks = false;
    }
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async doFullBlockSync() {
    if (this.fullSyncing) {
      return;
    }
    this.fullSyncing = true;
    const factory = await this.communityFactoryService.getCurrentFactory();
    this.bclBlockNumber = factory.block_number;

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
    const query: Record<string, string | number> = {
      direction: 'forward',
      limit: 100,
      scope: `gen:${blockNumber}`,
      type: 'contract_call',
    };
    const queryString = Object.keys(query)
      .map((key) => key + '=' + query[key])
      .join('&');
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

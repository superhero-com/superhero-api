import { CommunityFactoryService } from '@/ae/community-factory.service';
import {
  MAX_RETRIES_WHEN_REQUEST_FAILED,
  TOTAL_BLOCKS_TO_HAVE_STABLE_DATA,
  WAIT_TIME_WHEN_REQUEST_FAILED,
} from '@/configs/constants';
import { ACTIVE_NETWORK } from '@/configs/network';
import {
  PULL_TOKEN_INFO_QUEUE,
  SYNC_TOKEN_HOLDERS_QUEUE,
} from '@/tokens/queues/constants';
import { TokensService } from '@/tokens/tokens.service';
import { TransactionService } from '@/transactions/services/transaction.service';
import { SyncState } from '@/mdw-sync/entities/sync-state.entity';
import { fetchJson } from '@/utils/common';
import { InjectQueue } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommunityFactory } from 'bctsl-sdk';
import { Queue } from 'bull';
import camelcaseKeysDeep from 'camelcase-keys-deep';

@Injectable()
export class FastPullTokensService {
  pullingTokens = false;
  factoryContract: CommunityFactory;
  private readonly logger = new Logger(FastPullTokensService.name);

  constructor(
    private readonly tokensService: TokensService,
    private communityFactoryService: CommunityFactoryService,
    private readonly transactionService: TransactionService,
    @InjectRepository(SyncState)
    private syncStateRepository: Repository<SyncState>,

    @InjectQueue(SYNC_TOKEN_HOLDERS_QUEUE)
    private readonly pullTokenHoldersQueue: Queue,

    @InjectQueue(PULL_TOKEN_INFO_QUEUE)
    private readonly pullTokenInfoQueue: Queue,
  ) {
    //
  }

  onModuleInit() {
    // this.fastPullTokens();
  }

  isPullingLatestCreatedTokens = false;
  @Cron(CronExpression.EVERY_10_MINUTES)
  async pullLatestCreatedTokens() {
    // Note: Token creation is now handled by BclPlugin via MDW sync system
    // This method is kept for backward compatibility but may be removed in future
    if (this.isPullingLatestCreatedTokens) {
      return;
    }
    try {
      this.isPullingLatestCreatedTokens = true;
      // delete all tokens where dao_address is null
      await this.tokensService.deleteTokensWhereDaoAddressIsNull();
      const factory = await this.communityFactoryService.getCurrentFactory();

      // Get tip height from MDW sync state
      const syncState = await this.syncStateRepository.findOne({
        where: { id: 'global' },
      });
      const latestBlockNumber = syncState?.tip_height || 0;

      if (!latestBlockNumber) {
        return;
      }

      const from = latestBlockNumber - TOTAL_BLOCKS_TO_HAVE_STABLE_DATA;
      if (from < 0) {
        this.logger.error(
          `FastPullTokensService->pullLatestCreatedTokens: from is less than 0`,
        );
        this.isPullingLatestCreatedTokens = false;
        return;
      }
      const queryString = new URLSearchParams({
        direction: 'backward',
        limit: '100',
        scope: `gen:${from}-${latestBlockNumber}`,
        type: 'contract_call',
        contract: factory.address,
      }).toString();

      const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions?${queryString}`;
      await this.loadCreatedCommunityFromMdw(url);
    } finally {
      this.isPullingLatestCreatedTokens = false;
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_10AM)
  async fastPullTokens() {
    // Note: Token creation is now handled by BclPlugin via MDW sync system
    // This method is kept for backward compatibility but may be removed in future
    if (this.pullingTokens) {
      return;
    }
    // clear all queue for meta info & token holders sync
    await Promise.all([
      this.pullTokenHoldersQueue.empty(),
      this.pullTokenInfoQueue.empty(),
    ]);
    this.pullingTokens = true;

    try {
      const factory = await this.communityFactoryService.getCurrentFactory();

      const queryString = new URLSearchParams({
        direction: 'backward',
        limit: '100',
        type: 'contract_call',
        contract: factory.address,
      }).toString();
      const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions?${queryString}`;

      await this.loadCreatedCommunityFromMdw(url);
    } catch (error: any) {
      this.logger.error(
        `FastPullTokensService->fastPullTokens: ${error.message}`,
        error.stack,
      );
    }

    this.pullingTokens = false;
  }

  private async loadCreatedCommunityFromMdw(url: string): Promise<void> {
    let nextUrl: string | null = url;

    while (nextUrl) {
      this.logger.log('loadCreatedCommunityFromMdw->url::', nextUrl);

      let result: any;
      let retries = 0;
      while (true) {
        try {
          result = await fetchJson(nextUrl);
          break;
        } catch (error) {
          if (retries < MAX_RETRIES_WHEN_REQUEST_FAILED) {
            retries++;
            await new Promise((resolve) =>
              setTimeout(resolve, WAIT_TIME_WHEN_REQUEST_FAILED),
            );
          } else {
            this.logger.error('loadCreatedCommunityFromMdw->error::', error);
            return;
          }
        }
      }

      if (result?.data?.length) {
        for (const transaction of result.data) {
          try {
            const token =
              await this.tokensService.createTokenFromRawTransaction(
                transaction,
              );
            if (!token) {
              continue;
            }
            await this.transactionService.saveTransaction(
              camelcaseKeysDeep(transaction),
              token,
            );
          } catch (error: any) {
            this.logger.error(
              `loadCreatedCommunityFromMdw->error:: for tx: ${transaction?.tx?.hash}`,
              error?.message,
              error?.stack,
            );
          }
        }
      } else {
        this.logger.log('loadCreatedCommunityFromMdw->no data::', nextUrl);
      }

      nextUrl = result.next
        ? `${ACTIVE_NETWORK.middlewareUrl}${result.next}`
        : null;
    }
  }
}

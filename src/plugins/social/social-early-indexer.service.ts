import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { Repository } from 'typeorm';
import { WebSocketService } from '@/ae/websocket.service';
import { ACTIVE_NETWORK } from '@/configs';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { SyncDirectionEnum } from '@/mdw-sync/types/sync-direction';
import { toMdwTx } from '@/mdw-sync/utils/to-mdw-tx';
import { Post } from '@/social/entities/post.entity';
import { IPostContract } from '@/social/interfaces/post.interfaces';
import { fetchJson } from '@/utils/common';
import { ITransaction } from '@/utils/types';
import { getActiveContractAddresses } from './config/post-contracts.config';
import { PostTransactionProcessorService } from './services/post-transaction-processor.service';
import { PostTypeDetectionService } from './services/post-type-detection.service';

const MDW_RETRY_INTERVAL_MS = 2_000;
const MDW_DEADLINE_MS = 90_000;
const MAX_QUEUE_LENGTH = 100;
const MAX_RECENT_HASHES = 1_000;

/**
 * Indexes post-contract calls as soon as the node reports them mined. MDW
 * only pushes a transaction after the next key block (minutes later), but
 * its REST endpoint has it within seconds.
 *
 * Only the post is written here. The MDW path still runs later with the
 * final block data, finds the post, and alone writes `txs` and emits
 * LIVE_TX_EVENT, so no other plugin or listener sees a change.
 */
@Injectable()
export class SocialEarlyIndexerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SocialEarlyIndexerService.name);
  private contracts = new Set<string>();
  private readonly queue: string[] = [];
  private readonly recentHashes = new Set<string>();
  private draining = false;
  private stopped = false;
  private unsubscribe?: () => void;

  constructor(
    @InjectRepository(Post)
    private readonly postRepository: Repository<Post>,
    private readonly websocketService: WebSocketService,
    private readonly configService: ConfigService,
    private readonly typeDetectionService: PostTypeDetectionService,
    private readonly processor: PostTransactionProcessorService,
  ) {}

  onModuleInit(): void {
    if (
      process.env.DISABLE_MDW_SYNC === 'true' ||
      process.env.SOCIAL_EARLY_INDEXING_ENABLED === 'false'
    ) {
      return;
    }
    this.contracts = new Set(
      getActiveContractAddresses(
        this.configService.get<IPostContract[]>('social.contracts', []),
      ),
    );
    if (this.contracts.size === 0) {
      return;
    }
    this.unsubscribe = this.websocketService.subscribeForTransactionsUpdates(
      (transaction) => this.enqueue(transaction),
      'node',
    );
  }

  onModuleDestroy(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.queue.length = 0;
  }

  private enqueue(transaction: ITransaction): void {
    const hash = transaction?.hash;
    if (
      this.stopped ||
      !hash ||
      transaction.tx?.type !== 'ContractCallTx' ||
      !this.contracts.has(transaction.tx.contractId) ||
      this.recentHashes.has(hash)
    ) {
      return;
    }
    if (this.queue.length >= MAX_QUEUE_LENGTH) {
      this.logger.warn('Early indexing queue is full, leaving tx to MDW', {
        hash,
      });
      return;
    }
    // A repeat delivery would only cost another MDW fetch.
    this.recentHashes.add(hash);
    if (this.recentHashes.size > MAX_RECENT_HASHES) {
      this.recentHashes.delete(this.recentHashes.values().next().value);
    }
    this.queue.push(hash);
    void this.drain();
  }

  // One at a time in arrival order, so a post is saved before replies to it.
  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (!this.stopped && this.queue.length > 0) {
        await this.index(this.queue.shift());
      }
    } finally {
      this.draining = false;
    }
  }

  private async index(hash: string): Promise<void> {
    try {
      const transaction = await this.fetchMinedTransaction(hash);
      if (this.stopped) {
        return;
      }
      if (!transaction) {
        this.logger.warn('MDW did not return tx in time, leaving it to MDW', {
          hash,
        });
        return;
      }

      const tx = toMdwTx(transaction) as Tx;
      // Indexing it now would save a reply as a top-level post until the MDW
      // path re-links it.
      const postType = this.typeDetectionService.detectPostType(tx);
      if (postType?.isComment && postType.parentPostId) {
        const parentExists = await this.postRepository.exists({
          where: { id: postType.parentPostId },
        });
        if (!parentExists) {
          this.logger.debug('Reply parent not indexed yet, leaving it to MDW', {
            hash,
            parentPostId: postType.parentPostId,
          });
          return;
        }
      }

      const result = await this.processor.processTransaction(
        tx,
        SyncDirectionEnum.Live,
      );
      if (result?.success && result.post) {
        this.logger.log('Indexed post before key block', {
          hash,
          postId: result.post.id,
        });
      } else if (result && !result.success && !result.skipped) {
        this.logger.warn('Early indexing failed, leaving tx to MDW', {
          hash,
          error: result.error,
        });
      }
    } catch (error) {
      this.logger.error('Early indexing failed, leaving tx to MDW', {
        hash,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async fetchMinedTransaction(
    hash: string,
  ): Promise<ITransaction | null> {
    const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions/${hash}`;
    const deadline = Date.now() + MDW_DEADLINE_MS;
    while (!this.stopped) {
      try {
        const response = await fetchJson(url, undefined, true);
        const transaction = response
          ? (camelcaseKeysDeep(response) as ITransaction)
          : null;
        if (transaction?.hash === hash && transaction.blockHash) {
          return transaction;
        }
      } catch (error) {
        // 404 until MDW has synced the micro block; retry everything else too.
        this.logger.debug('MDW does not have tx yet', {
          hash,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (Date.now() + MDW_RETRY_INTERVAL_MS > deadline) {
        return null;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, MDW_RETRY_INTERVAL_MS);
        timer.unref?.();
      });
    }
    return null;
  }
}

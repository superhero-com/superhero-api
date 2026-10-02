import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Post } from '@/social/entities/post.entity';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { IPostContract } from '@/social/interfaces/post.interfaces';
import { parsePostContent } from '@/social/utils/content-parser.util';
import { SyncDirection } from '../../plugin.interface';
import { SyncDirectionEnum } from '@/mdw-sync/types/sync-direction';
import { PostTransactionValidationService } from './post-transaction-validation.service';
import { PostTypeDetectionService } from './post-type-detection.service';
import { TopicManagementService } from './topic-management.service';
import { PostPersistenceService } from './post-persistence.service';
import { TokensService } from '@/tokens/tokens.service';
import { refreshTrendingScoresForPostSafely } from '@/social/utils/token-mentions.util';

export interface ProcessPostTransactionResult {
  post: Post | null;
  success: boolean;
  skipped: boolean;
  error?: string;
}

@Injectable()
export class PostTransactionProcessorService {
  private readonly logger = new Logger(PostTransactionProcessorService.name);
  private readonly inFlight = new Map<
    string,
    Promise<ProcessPostTransactionResult | null>
  >();

  constructor(
    @InjectRepository(Post)
    private readonly postRepository: Repository<Post>,
    private readonly validationService: PostTransactionValidationService,
    private readonly typeDetectionService: PostTypeDetectionService,
    private readonly topicManagementService: TopicManagementService,
    private readonly persistenceService: PostPersistenceService,
    private readonly tokensService: TokensService,
  ) {}

  /**
   * Process a transaction end-to-end
   * @param tx - Transaction entity
   * @param syncDirection - Forwarded so downstream notification emit sites
   *   can gate on Live and avoid paging users during historical replays.
   *   Defaults to Live to keep call sites that haven't been threaded through
   *   working as before (no false negatives during real-time indexing).
   * @returns Processing result or null if transaction should be skipped
   */
  async processTransaction(
    tx: Tx,
    syncDirection: SyncDirection = SyncDirectionEnum.Live,
  ): Promise<ProcessPostTransactionResult | null> {
    // The early indexer, the MDW push and the cron can deliver one hash at
    // once. Queued, later runs find the post instead of a duplicate key.
    const previous = this.inFlight.get(tx.hash);
    const run = (previous ?? Promise.resolve(null))
      .catch(() => null)
      .then(() => this.processTransactionOnce(tx, syncDirection));
    this.inFlight.set(tx.hash, run);
    try {
      return await run;
    } finally {
      if (this.inFlight.get(tx.hash) === run) {
        this.inFlight.delete(tx.hash);
      }
    }
  }

  private async processTransactionOnce(
    tx: Tx,
    syncDirection: SyncDirection,
  ): Promise<ProcessPostTransactionResult | null> {
    const txHash = tx.hash;

    try {
      // Validate transaction and contract
      const validation = await this.validationService.validateTransaction(tx);

      if (!validation.isValid || !validation.contract) {
        return {
          post: null,
          success: false,
          skipped: true,
          error: validation.error || 'Invalid transaction or contract',
        };
      }

      const contract = validation.contract;

      // Detect post type
      const postTypeInfo = this.typeDetectionService.detectPostType(tx);
      if (!postTypeInfo) {
        this.logger.warn('Could not detect post type', { txHash });
        return {
          post: null,
          success: false,
          skipped: true,
          error: 'Could not detect post type',
        };
      }

      // Check if post already exists
      const existingPost =
        await this.persistenceService.getExistingPost(txHash);
      if (existingPost) {
        this.logPostIdMismatch(existingPost, tx, contract);
      }

      // Handle existing post that needs to be converted to comment
      if (existingPost && postTypeInfo.isComment && !existingPost.post_id) {
        const result =
          await this.persistenceService.processExistingPostAsComment(
            existingPost,
            postTypeInfo,
            txHash,
            syncDirection,
          );

        if (result.success) {
          await refreshTrendingScoresForPostSafely({
            post: {
              ...existingPost,
              post_id: postTypeInfo.parentPostId,
            } as Post,
            loadParentPost: (postId) =>
              this.postRepository.findOne({
                where: { id: postId },
              }),
            updateTrendingScoresForSymbols: (symbols) =>
              this.tokensService.queueTrendingScoresForSymbols(symbols),
            logError: (message, trace) => this.logger.error(message, trace),
            errorMessage:
              'Failed to refresh trending scores after processing post transaction',
          });
          return {
            post: existingPost,
            success: true,
            skipped: false,
          };
        } else {
          this.logger.warn('Failed to process existing post as comment', {
            txHash,
            error: result.error,
            parentPostExists: result.parentPostExists,
          });
          // Continue with regular flow if comment processing fails
        }
      }

      // Return existing post if it already exists
      if (existingPost) {
        return {
          post: existingPost,
          success: true,
          skipped: false,
        };
      }

      // Validate content
      const content = this.persistenceService.validateContent(tx);
      if (!content) {
        this.logger.warn('Transaction missing or invalid content', { txHash });
        return {
          post: null,
          success: false,
          skipped: true,
          error: 'Missing or invalid content',
        };
      }

      // For new comments, validate parent post exists with retry logic.
      // Hoisted so the post-commit notification emit below can read
      // `parentPost.sender_address` without a second findOne.
      let parentPost: Post | null = null;
      if (postTypeInfo.isComment && postTypeInfo.parentPostId) {
        parentPost = await this.persistenceService.validateParentPost(
          postTypeInfo.parentPostId,
        );
        if (!parentPost) {
          this.logger.warn(
            'Cannot create comment: parent post not found after retries',
            {
              txHash,
              parentPostId: postTypeInfo.parentPostId,
            },
          );
          // Convert to regular post instead of comment to prevent FK constraint violation
          const originalParentPostId = postTypeInfo.parentPostId;
          postTypeInfo.isComment = false;
          postTypeInfo.parentPostId = undefined;
          this.logger.log('Converting orphaned comment to regular post', {
            txHash,
            originalParentPostId,
          });
        }
      }

      // Parse content and extract metadata
      const parsedContent = parsePostContent(
        content,
        tx.raw?.arguments?.[1]?.value || [],
      );

      // Create or get topics
      const topics = await this.topicManagementService.createOrGetTopics(
        parsedContent.topics,
      );

      // Create post data
      let postData = this.persistenceService.createPostData(
        tx,
        contract,
        parsedContent,
        topics,
        postTypeInfo,
      );

      // Validate and clean post data
      postData = this.persistenceService.validatePostData(postData, txHash);

      // A fork can hand this tx an id an early-indexed post already holds, and
      // save() would then silently overwrite that post.
      const holder = await this.postRepository.findOne({
        where: { id: postData.id },
        select: { id: true, tx_hash: true },
      });
      if (holder && holder.tx_hash !== txHash) {
        this.logger.error('Post id already belongs to another transaction', {
          txHash,
          postId: postData.id,
          overwrittenTxHash: holder.tx_hash,
        });
      }

      this.logger.debug('Creating new post', {
        txHash,
        postId: postData.id,
        isComment: postTypeInfo.isComment,
        parentPostId: postData.post_id,
        topicsCount: postData.topics.length,
        mediaCount: postData.media.length,
      });

      // Use database transaction for consistency
      const post = await this.postRepository.manager.transaction(
        async (manager: EntityManager) => {
          const savedPost = await this.persistenceService.savePost(
            postData,
            topics,
            manager,
          );

          // Update topic post counts within the same transaction
          await this.topicManagementService.updateTopicPostCounts(
            topics,
            manager,
          );

          return savedPost;
        },
      );

      // Update parent post comment count if this is a comment
      if (postTypeInfo.isComment && postTypeInfo.parentPostId) {
        await this.persistenceService.updatePostCommentCount(
          postTypeInfo.parentPostId,
        );
      }

      // Notify the parent post's author. Emit AFTER the manager.transaction
      // resolves so a rollback can't leak a phantom push (see F1 in round-3
      // findings). `parentPost` is guaranteed non-null when isComment is still
      // true here — the validateParentPost branch above flips isComment to
      // false on null. Gated on Live inside the helper.
      if (postTypeInfo.isComment && parentPost) {
        this.persistenceService.emitCommentCreatedEvent(
          parentPost,
          post,
          txHash,
          syncDirection,
        );
      }

      await refreshTrendingScoresForPostSafely({
        post,
        loadParentPost: (postId) =>
          this.postRepository.findOne({
            where: { id: postId },
          }),
        updateTrendingScoresForSymbols: (symbols) =>
          this.tokensService.queueTrendingScoresForSymbols(symbols),
        logError: (message, trace) => this.logger.error(message, trace),
        errorMessage:
          'Failed to refresh trending scores after processing post transaction',
      });

      return {
        post,
        success: true,
        skipped: false,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      this.logger.error('Failed to process post transaction', {
        txHash,
        error: errorMessage,
        stack: errorStack,
      });

      return {
        post: null,
        success: false,
        skipped: false,
        error: errorMessage,
      };
    }
  }

  /**
   * A post indexed from a block that later lost a micro-fork can carry a
   * different return value, and so a different id, than the final chain.
   * Detection only: rewriting the id would orphan replies and tips.
   */
  private logPostIdMismatch(
    existingPost: Post,
    tx: Tx,
    contract: IPostContract,
  ): void {
    const computedId = this.persistenceService.generatePostId(tx, contract);
    if (computedId !== existingPost.id) {
      this.logger.error('Stored post id differs from the chain result', {
        txHash: tx.hash,
        storedId: existingPost.id,
        computedId,
      });
    }
  }
}

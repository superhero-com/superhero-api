import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Post } from '@/social/entities/post.entity';
import { Topic } from '@/social/entities/topic.entity';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import {
  IPostContract,
  ICreatePostData,
  IPostTypeInfo,
  ICommentProcessingResult,
} from '@/social/interfaces/post.interfaces';
import {
  POST_COMMENT_CREATED_EVENT,
  PostCommentCreatedEventPayload,
} from '../events';
import { SyncDirection } from '../../plugin.interface';
import { SyncDirectionEnum } from '@/mdw-sync/types/sync-direction';
import moment from 'moment';

@Injectable()
export class PostPersistenceService {
  private readonly logger = new Logger(PostPersistenceService.name);
  private readonly syncVersion = 6; // Match PostService syncVersion

  constructor(
    @InjectRepository(Post)
    private readonly postRepository: Repository<Post>,
    @InjectRepository(Topic)
    private readonly topicRepository: Repository<Topic>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Validates that a parent post exists for a comment with retry logic
   * This handles timing issues in parallel processing where parent posts
   * might be processed concurrently.
   *
   * Returns the loaded `Post` on success (or `null` if not found after
   * retries) so callers don't have to re-query the parent for things like
   * the author address. Callers using it as a boolean (`if (!validateParentPost…)`)
   * still work via JS truthiness.
   */
  async validateParentPost(
    parentPostId: string,
    maxRetries: number = 3,
    retryDelay: number = 100,
  ): Promise<Post | null> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const parentPost = await this.postRepository
          .createQueryBuilder('post')
          .where('post.id = :parentPostId', { parentPostId })
          .getOne();
        if (parentPost) {
          this.logger.debug('Parent post found for comment validation', {
            parentPostId,
            attempt,
          });
          return parentPost;
        }

        // If not found and we have retries left, wait and try again
        if (attempt < maxRetries) {
          this.logger.debug('Parent post not found, retrying...', {
            parentPostId,
            attempt,
            nextRetryIn: retryDelay,
          });
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
          retryDelay *= 2; // Exponential backoff
        }
      } catch (error) {
        this.logger.error('Error during parent post validation', {
          parentPostId,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });

        if (attempt === maxRetries) {
          return null;
        }

        // Apply exponential backoff delay before retrying on errors
        this.logger.debug('Retrying after error with exponential backoff', {
          parentPostId,
          attempt,
          nextRetryIn: retryDelay,
        });
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay *= 2; // Exponential backoff
      }
    }

    this.logger.warn('Parent post not found after all retries', {
      parentPostId,
      maxRetries,
    });
    return null;
  }

  /**
   * Processes comment-specific logic for existing posts.
   *
   * `syncDirection` defaults to Live so older internal callers that haven't
   * been threaded through keep producing notifications for fresh chain
   * events. Historical backfills (`syncDirection === Backward`) and reorg
   * replays don't emit — otherwise a full resync would page every post
   * author for years of historical comments.
   */
  async processExistingPostAsComment(
    existingPost: Post,
    postTypeInfo: IPostTypeInfo,
    txHash: string,
    syncDirection: SyncDirection = SyncDirectionEnum.Live,
  ): Promise<ICommentProcessingResult> {
    if (!postTypeInfo.isComment || !postTypeInfo.parentPostId) {
      return { success: false, error: 'Invalid comment information' };
    }

    // Check if parent post exists. The loaded entity is reused below to
    // avoid a second findOne for the author address.
    const parentPost = await this.validateParentPost(postTypeInfo.parentPostId);
    if (!parentPost) {
      this.logger.warn('Parent post does not exist for comment', {
        txHash,
        parentPostId: postTypeInfo.parentPostId,
      });
      return {
        success: false,
        parentPostExists: false,
        error: 'Parent post not found',
      };
    }

    try {
      // Update existing post to be a comment
      await this.postRepository.update(existingPost.id, {
        post_id: postTypeInfo.parentPostId,
      });

      // Update comment count for parent post
      await this.updatePostCommentCount(postTypeInfo.parentPostId);

      this.logger.log('Successfully updated existing post as comment', {
        txHash,
        postId: existingPost.id,
        parentPostId: postTypeInfo.parentPostId,
      });

      this.emitCommentCreatedEvent(
        parentPost,
        existingPost,
        txHash,
        syncDirection,
      );

      return { success: true, parentPostExists: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to process existing post as comment', {
        txHash,
        postId: existingPost.id,
        parentPostId: postTypeInfo.parentPostId,
        error: errorMessage,
      });
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Emits POST_COMMENT_CREATED_EVENT for the notification module.
   *
   * Called from BOTH comment-creation paths in PostTransactionProcessorService:
   *   1. Fresh comment indexed straight through (the common case).
   *   2. Existing post reclassified as a comment via
   *      processExistingPostAsComment (the re-index/migration case).
   *
   * Centralized here so the two paths can't drift on emit gating. Gated on
   * Live to avoid paging users during historical backfills/reorg replays.
   * Defensive checks for self-comments and missing recipients live in the
   * listener so we only guard the null dereferences needed for the payload.
   */
  emitCommentCreatedEvent(
    parentPost: Post,
    commentPost: Post,
    txHash: string,
    syncDirection: SyncDirection,
  ): void {
    if (syncDirection !== SyncDirectionEnum.Live) {
      return;
    }
    if (!parentPost.sender_address || !commentPost.sender_address) {
      return;
    }
    try {
      const payload: PostCommentCreatedEventPayload = {
        commenterAddress: commentPost.sender_address,
        postAuthorAddress: parentPost.sender_address,
        parentPostId: parentPost.id,
        commentId: commentPost.id,
        txHash,
      };
      this.eventEmitter.emit(POST_COMMENT_CREATED_EVENT, payload);
    } catch (notifyError) {
      // Notification dispatch must never break indexing.
      this.logger.warn('Failed to emit post-comment notification event', {
        txHash,
        parentPostId: parentPost.id,
        error:
          notifyError instanceof Error
            ? notifyError.message
            : String(notifyError),
      });
    }
  }

  /**
   * Updates the comment count for a parent post
   */
  async updatePostCommentCount(parentPostId: string): Promise<void> {
    try {
      const count = await this.postRepository
        .createQueryBuilder('post')
        .where('post.post_id = :parentPostId', { parentPostId })
        .getCount();

      await this.postRepository.update(
        { id: parentPostId },
        { total_comments: count },
      );

      this.logger.debug('Updated comment count for parent post', {
        parentPostId,
        commentCount: count,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to update comment count', {
        parentPostId,
        error: errorMessage,
      });
      // Don't throw - comment count update failure shouldn't break the main flow
    }
  }

  /**
   * Generates a unique post ID
   */
  generatePostId(tx: Tx, contract: IPostContract): string {
    const returnValue = tx.raw?.return?.value;
    if (returnValue) {
      return `${returnValue}_v${contract.version}`;
    }

    // Fallback to hash-based ID if return value is not available
    return `${tx.hash.slice(-8)}_v${contract.version}`;
  }

  /**
   * Generates a post slug
   */
  generatePostSlug(content: string, postId: string): string {
    const suffix = postId.split('_')[0];
    const base = this.normalizeSlugPart(content).slice(0, 60);
    const combined = base ? `${base}-${suffix}` : suffix;
    return combined.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  }

  /**
   * Normalizes a slug part
   */
  private normalizeSlugPart(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}._~-]+/gu, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Saves a post with topics within a database transaction
   */
  async savePost(
    postData: ICreatePostData,
    topics: Topic[],
    manager: EntityManager,
  ): Promise<Post> {
    const newPost = manager.create(Post, postData);
    const savedPost = await manager.save(newPost);
    return savedPost;
  }

  /**
   * Gets existing post by transaction hash
   */
  async getExistingPost(txHash: string): Promise<Post | null> {
    return await this.postRepository.findOne({
      where: { tx_hash: txHash },
    });
  }

  /**
   * Creates post data from transaction
   */
  createPostData(
    tx: Tx,
    contract: IPostContract,
    parsedContent: {
      content: string;
      topics: string[];
      media: string[];
      trendMentions: string[];
    },
    topics: Topic[],
    postTypeInfo: IPostTypeInfo,
  ): ICreatePostData {
    const id = this.generatePostId(tx, contract);
    const slug = this.generatePostSlug(parsedContent.content, id);

    return {
      id: id,
      slug: slug,
      type: tx.function || tx.raw?.function || 'unknown',
      tx_hash: tx.hash,
      sender_address: tx.caller_id || tx.raw?.callerId || '',
      contract_address: tx.contract_id || tx.raw?.contractId || '',
      content: parsedContent.content,
      token_mentions: parsedContent.trendMentions,
      topics: topics,
      media: parsedContent.media,
      total_comments: 0,
      tx_args: tx.raw?.arguments || [],
      created_at: moment(tx.created_at || parseInt(tx.micro_time)).toDate(),
      post_id:
        postTypeInfo.isComment && postTypeInfo.parentPostId
          ? postTypeInfo.parentPostId
          : null,
      is_hidden: postTypeInfo.isHidden,
      version: this.syncVersion,
    };
  }

  /**
   * Validates and cleans post data before saving
   */
  validatePostData(postData: ICreatePostData, txHash: string): ICreatePostData {
    // Final validation: ensure post_id is valid if it's set
    if (postData.post_id && postData.post_id.trim().length === 0) {
      this.logger.warn('Removing invalid empty post_id before save', {
        txHash,
        postId: postData.id,
      });
      postData.post_id = null;
    }
    return postData;
  }

  /**
   * Validates transaction content
   */
  validateContent(tx: Tx): string | null {
    if (!tx.raw?.arguments?.[0]?.value) {
      return null;
    }

    const content = tx.raw.arguments[0].value;
    if (typeof content !== 'string' || content.trim().length === 0) {
      return null;
    }

    return content;
  }
}

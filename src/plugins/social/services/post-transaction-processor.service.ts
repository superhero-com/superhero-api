import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Post } from '@/social/entities/post.entity';
import { Topic } from '@/social/entities/topic.entity';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { IPostContract, IPostProcessingResult, IPostTypeInfo } from '@/social/interfaces/post.interfaces';
import { parsePostContent } from '@/social/utils/content-parser.util';
import { PostTransactionValidationService } from './post-transaction-validation.service';
import { PostTypeDetectionService } from './post-type-detection.service';
import { TopicManagementService } from './topic-management.service';
import { PostPersistenceService } from './post-persistence.service';

export interface ProcessPostTransactionResult {
  post: Post | null;
  success: boolean;
  skipped: boolean;
  error?: string;
}

@Injectable()
export class PostTransactionProcessorService {
  private readonly logger = new Logger(PostTransactionProcessorService.name);

  constructor(
    @InjectRepository(Post)
    private readonly postRepository: Repository<Post>,
    private readonly validationService: PostTransactionValidationService,
    private readonly typeDetectionService: PostTypeDetectionService,
    private readonly topicManagementService: TopicManagementService,
    private readonly persistenceService: PostPersistenceService,
  ) {}

  /**
   * Process a transaction end-to-end
   * @param tx - Transaction entity
   * @returns Processing result or null if transaction should be skipped
   */
  async processTransaction(
    tx: Tx,
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
      const existingPost = await this.persistenceService.getExistingPost(txHash);

      // Handle existing post that needs to be converted to comment
      if (existingPost && postTypeInfo.isComment && !existingPost.post_id) {
        const result = await this.persistenceService.processExistingPostAsComment(
          existingPost,
          postTypeInfo,
          txHash,
        );

        if (result.success) {
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

      // For new comments, validate parent post exists with retry logic
      if (postTypeInfo.isComment && postTypeInfo.parentPostId) {
        const parentPostExists = await this.persistenceService.validateParentPost(
          postTypeInfo.parentPostId,
        );
        if (!parentPostExists) {
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
          await this.topicManagementService.updateTopicPostCounts(topics, manager);

          return savedPost;
        },
      );

      // Update parent post comment count if this is a comment
      if (postTypeInfo.isComment && postTypeInfo.parentPostId) {
        await this.persistenceService.updatePostCommentCount(
          postTypeInfo.parentPostId,
        );
      }

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
}


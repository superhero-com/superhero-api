import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Post } from '../entities/post.entity';
import { Topic } from '../entities/topic.entity';
import {
  ACTIVE_NETWORK,
  MAX_RETRIES_WHEN_REQUEST_FAILED,
  PULL_SOCIAL_POSTS_ENABLED,
  WAIT_TIME_WHEN_REQUEST_FAILED,
} from '@/configs';
import { fetchJson } from '@/utils/common';
import moment from 'moment';
import { ITransaction } from '@/utils/types';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import {
  POST_CONTRACTS,
  getContractByAddress,
  isContractSupported,
} from '../config/post-contracts.config';
import {
  IPostContract,
  ICreatePostData,
  IPostProcessingResult,
  IMiddlewareResponse,
  IMiddlewareRequestConfig,
  ICommentInfo,
  ICommentProcessingResult,
  IPostTypeInfo,
} from '../interfaces/post.interfaces';
import { parsePostContent } from '../utils/content-parser.util';
import { Account } from '@/account/entities/account.entity';

@Injectable()
export class PostService {
  syncVersion = 4;
  private readonly logger = new Logger(PostService.name);
  private readonly isProcessing = new Map<string, boolean>();

  constructor(
    @InjectRepository(Post)
    private readonly postRepository: Repository<Post>,

    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,

    @InjectRepository(Topic)
    private readonly topicRepository: Repository<Topic>,
  ) {
    this.logger.log('PostService initialized');
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('PostService module initialized successfully');
    this.sync();
  }

  async sync() {
    // delete posts and topics with different syncVersion with proper foreign key handling
    // Note: This will only clear posts and topics that don't match the current syncVersion
    await this.clearNonCompatibleData();

    if (PULL_SOCIAL_POSTS_ENABLED) {
      try {
        await this.pullLatestPostsForContracts();
        // Run cleanup for any orphaned comments from previous runs
        await this.fixOrphanedComments();
      } catch (error) {
        this.logger.error('Failed to initialize PostService module', error);
        // Don't throw - allow the service to start even if initial sync fails
      }
    }
  }

  async saveTransaction(transaction: ITransaction) {
    if (
      !this.validateTransaction(transaction) ||
      !isContractSupported(transaction.tx.contractId)
    ) {
      return;
    }
    const contract = getContractByAddress(transaction.tx.contractId);
    return this.savePostFromTransaction(transaction, contract);
  }

  async handleLiveTransaction(
    transaction: ITransaction,
  ): Promise<IPostProcessingResult> {
    const contractAddress = transaction?.tx?.contractId;

    if (!contractAddress || !isContractSupported(contractAddress)) {
      return {
        success: false,
        error: 'Missing contract ID or unsupported contract',
        skipped: true,
      };
    }

    const contract = getContractByAddress(contractAddress);
    if (!contract) {
      this.logger.error('Contract configuration not found', {
        contractAddress,
      });
      return { success: false, error: 'Contract configuration missing' };
    }

    try {
      const post = await this.savePostFromTransaction(transaction, contract);
      this.logger.log('Live transaction processed successfully', {
        hash: transaction.hash,
        contractAddress,
        postId: post?.id,
      });
      return { success: true, post };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      this.logger.error('Failed to process live transaction', {
        hash: transaction.hash,
        contractAddress,
        error: errorMessage,
        stack: errorStack,
      });
      return { success: false, error: errorMessage };
    }
  }

  async pullLatestPostsForContracts(): Promise<void> {
    const contractsProcessingKey = 'all_contracts';

    if (this.isProcessing.get(contractsProcessingKey)) {
      this.logger.warn('Contract processing already in progress, skipping...');
      return;
    }

    this.isProcessing.set(contractsProcessingKey, true);

    try {
      this.logger.log(
        `Starting to pull posts for ${POST_CONTRACTS.length} contracts`,
      );

      const results = await Promise.allSettled(
        POST_CONTRACTS.map((contract) => this.pullLatestPosts(contract)),
      );

      const successful = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.filter((r) => r.status === 'rejected').length;

      this.logger.log(
        `Contract processing completed: ${successful} successful, ${failed} failed`,
      );

      // Log any failures
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          const error =
            result.reason instanceof Error
              ? result.reason
              : new Error(String(result.reason));
          this.logger.error(
            `Failed to process contract ${POST_CONTRACTS[index].contractAddress}`,
            {
              error: error.message,
              stack: error.stack,
            },
          );
        }
      });
    } finally {
      this.isProcessing.delete(contractsProcessingKey);
    }
  }

  async pullLatestPosts(contract: IPostContract): Promise<any[]> {
    const processingKey = `contract_${contract.contractAddress}`;

    if (this.isProcessing.get(processingKey)) {
      this.logger.warn(
        `Contract ${contract.contractAddress} already being processed, skipping...`,
      );
      return [];
    }

    this.isProcessing.set(processingKey, true);

    try {
      const config: IMiddlewareRequestConfig = {
        direction: 'forward',
        limit: 100,
        type: 'contract_call',
        contract: contract.contractAddress,
      };

      const queryString = new URLSearchParams({
        direction: config.direction,
        limit: config.limit.toString(),
        type: config.type,
        contract: config.contract,
      }).toString();

      const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions?${queryString}`;

      const posts = await this.loadPostsFromMdw(url, contract);

      this.logger.log(
        `Successfully pulled ${posts.length} posts for contract ${contract.contractAddress}`,
      );

      return posts;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      this.logger.error(
        `Failed to pull posts for contract ${contract.contractAddress}`,
        {
          error: errorMessage,
          stack: errorStack,
        },
      );
      throw error;
    } finally {
      this.isProcessing.delete(processingKey);
    }
  }

  async loadPostsFromMdw(
    url: string,
    contract: IPostContract,
    posts: any[] = [],
    totalRetries = 0,
  ): Promise<any[]> {
    let result: IMiddlewareResponse;

    try {
      result = await fetchJson(url);
    } catch (error) {
      if (totalRetries < MAX_RETRIES_WHEN_REQUEST_FAILED) {
        const nextRetry = totalRetries + 1;
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        this.logger.warn(
          `Middleware request failed, retrying (${nextRetry}/${MAX_RETRIES_WHEN_REQUEST_FAILED})`,
          {
            url,
            error: errorMessage,
            retryIn: WAIT_TIME_WHEN_REQUEST_FAILED,
          },
        );

        await new Promise((resolve) =>
          setTimeout(resolve, WAIT_TIME_WHEN_REQUEST_FAILED),
        );
        return this.loadPostsFromMdw(url, contract, posts, nextRetry);
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      this.logger.error(
        'Failed to load posts from middleware after all retries',
        {
          url,
          error: errorMessage,
          stack: errorStack,
          totalRetries,
        },
      );
      return posts;
    }

    if (!result?.data?.length) {
      this.logger.debug('No data received from middleware', { url });
      return posts;
    }

    // Process transactions sequentially to handle parent-child dependencies
    // This ensures parent posts are created before their comments
    const successfulPosts: any[] = [];
    let failedCount = 0;

    for (const transaction of result.data) {
      try {
        const camelCasedTransaction = camelcaseKeysDeep(
          transaction,
        ) as ITransaction;
        const post = await this.savePostFromTransaction(
          camelCasedTransaction,
          contract,
        );
        if (post) {
          successfulPosts.push(post);
        }
      } catch (error) {
        failedCount++;
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger.warn('Failed to process individual transaction', {
          txHash: transaction?.hash,
          error: errorMessage,
        });
      }
    }

    posts.push(...successfulPosts);

    if (failedCount > 0) {
      this.logger.warn(
        `${failedCount} transactions failed to process in this batch`,
      );
    }

    // Continue with pagination if available
    if (result.next) {
      const nextUrl = `${ACTIVE_NETWORK.middlewareUrl}${result.next}`;
      return this.loadPostsFromMdw(nextUrl, contract, posts, 0);
    }

    return posts;
  }

  // 1
  async savePostFromTransaction(
    transaction: ITransaction,
    contract: IPostContract,
  ): Promise<Post | null> {
    if (!this.validateTransaction(transaction)) {
      this.logger.warn('Invalid transaction data', {
        hash: transaction?.hash,
      });
      return null;
    }

    const txHash = transaction.hash;
    /**
     * Handle different post type:
     * [
        {
            "title": "Commnet on a Post",
            "media": [
                "comment:{post_id}"
            ]
        },
        {
            "title": "My new bio",
            "media": [
                "bio-update",
                "hidden"
            ]
        },
        {
            "title": "See my new tokens",
            "media": [
                "bcl:{sale_address}"
            ]
        },
        {
            "title": "See my new tokens",
            "media": [
                "bcl-tx:{tx_hash}"
            ]
        },
        {
            "title": "I've made 10% gain on token x",
            "media": [
                "bcl-tx:{tx_hash}"
            ]
        }
    ]

     */
    const postTypeInfo = this.detectPostType(transaction);
    // const commentInfo = this.detectComment(transaction);

    try {
      // Check if post already exists
      const existingPost = await this.postRepository.findOne({
        where: { tx_hash: txHash },
      });

      // Handle existing post that needs to be converted to comment
      if (existingPost && postTypeInfo.isComment && !existingPost.post_id) {
        const result = await this.processExistingPostAsComment(
          existingPost,
          postTypeInfo,
          txHash,
        );

        if (result.success) {
          return existingPost;
        } else {
          this.logger.warn('Failed to process existing post as comment', {
            txHash,
            error: result.error,
            parentPostExists: result.parentPostExists,
          });
          // Continue with regular flow if comment processing fails
        }
      }

      if (existingPost) {
        return existingPost;
      }

      // Validate required transaction data
      if (!transaction.tx?.arguments?.[0]?.value) {
        this.logger.warn('Transaction missing content argument', { txHash });
        return null;
      }

      const content = transaction.tx.arguments[0].value;
      if (typeof content !== 'string' || content.trim().length === 0) {
        this.logger.warn('Invalid or empty content', { txHash });
        return null;
      }

      // Update or create the user account
      if (postTypeInfo.isBioUpdate) {
        try {
          const account = await this.accountRepository.findOne({
            where: { address: transaction.tx.callerId },
          });
          if (account) {
            await this.accountRepository.update(account.address, {
              bio: content,
            });
          } else {
            await this.accountRepository.save({
              address: transaction.tx.callerId,
              bio: content,
            });
          }
        } catch (error) {
          this.logger.error('Error updating or creating account', error);
        }
      }

      // For new comments, validate parent post exists with retry logic
      if (postTypeInfo.isComment && postTypeInfo.parentPostId) {
        const parentPostExists = await this.validateParentPost(
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
        transaction.tx.arguments[1]?.value || [],
      );

      // Create or get topics
      const topics = await this.createOrGetTopics(parsedContent.topics);

      // Create post data with proper validation
      const postData: ICreatePostData = {
        id: this.generatePostId(transaction, contract),
        type: transaction.tx.function || 'unknown',
        tx_hash: txHash,
        sender_address: transaction.tx.callerId,
        contract_address: transaction.tx.contractId,
        content: parsedContent.content,
        topics: topics,
        media: parsedContent.media,
        total_comments: 0,
        tx_args: transaction.tx.arguments,
        created_at: moment(transaction.microTime).toDate(),
        post_id:
          postTypeInfo.isComment && postTypeInfo.parentPostId
            ? postTypeInfo.parentPostId
            : null,
        is_hidden: postTypeInfo.isHidden,
        version: this.syncVersion,
      };

      this.logger.debug('Creating new post', {
        txHash,
        postId: postData.id,
        isComment: postTypeInfo.isComment,
        parentPostId: postData.post_id,
        topicsCount: postData.topics.length,
        mediaCount: postData.media.length,
      });

      // Final validation: ensure post_id is valid if it's set
      if (postData.post_id && postData.post_id.trim().length === 0) {
        this.logger.warn('Removing invalid empty post_id before save', {
          txHash,
          postId: postData.id,
        });
        postData.post_id = null;
      }

      // Use database transaction for consistency
      const post = await this.postRepository.manager.transaction(
        async (manager) => {
          const newPost = manager.create(Post, postData);
          const savedPost = await manager.save(newPost);

          // Update topic post counts
          await this.updateTopicPostCounts(topics);

          return savedPost;
        },
      );

      // Update parent post comment count if this is a comment
      if (postTypeInfo.isComment && postTypeInfo.parentPostId) {
        await this.updatePostCommentCount(postTypeInfo.parentPostId);
      }

      this.logger.log('Post saved successfully', {
        txHash,
        postId: post.id,
        isComment: postTypeInfo.isComment,
        parentPostId: postData.post_id,
        contractAddress: contract.contractAddress,
      });

      return post;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      this.logger.error('Failed to save post from transaction', {
        txHash,
        contractAddress: contract.contractAddress,
        error: errorMessage,
        stack: errorStack,
      });
      throw error;
    }
  }

  /**
   * Validates transaction data structure
   */
  private validateTransaction(transaction: ITransaction): boolean {
    if (!transaction) {
      return false;
    }

    const requiredFields = ['hash', 'microTime'];
    for (const field of requiredFields) {
      if (!transaction[field]) {
        this.logger.warn(`Transaction missing required field: ${field}`);
        return false;
      }
    }

    if (!transaction.tx) {
      this.logger.warn('Transaction missing tx data');
      return false;
    }

    const requiredTxFields = ['callerId', 'contractId', 'arguments'];
    for (const field of requiredTxFields) {
      if (!transaction.tx[field]) {
        this.logger.warn(`Transaction.tx missing required field: ${field}`);
        return false;
      }
    }

    return true;
  }

  /**
   * Generates a unique post ID
   */
  private generatePostId(
    transaction: ITransaction,
    contract: IPostContract,
  ): string {
    const returnValue = transaction.tx?.return?.value;
    if (returnValue) {
      return `${returnValue}_v${contract.version}`;
    }

    // Fallback to hash-based ID if return value is not available
    return `${transaction.hash.slice(-8)}_v${contract.version}`;
  }

  private detectPostType(transaction: ITransaction): IPostTypeInfo | null {
    if (!transaction?.tx?.arguments?.[1]?.value) {
      return null;
    }
    const argument = transaction.tx.arguments[1];

    const postTypeInfo: IPostTypeInfo = {
      isComment: false,

      isBioUpdate: false,
      isBclSale: false,
      isBclTx: false,
      isBclGain: false,
    };

    postTypeInfo.isComment = argument.value.some((arg) =>
      arg.value?.includes('comment:'),
    );
    if (postTypeInfo.isComment) {
      const parentPostId = argument.value
        .find((arg) => arg.value?.includes('comment:'))
        ?.value?.split('comment:')[1];

      // Validate and clean the parent post ID
      if (parentPostId && parentPostId.trim().length > 0) {
        postTypeInfo.parentPostId = parentPostId.trim();
        // if post id doesn't end with _v3 add it
        if (!parentPostId.endsWith('_v3')) {
          postTypeInfo.parentPostId = `${parentPostId}_v3`;
        }
      } else {
        this.logger.warn(
          'Invalid comment format: missing or empty parent post ID',
          {
            txHash: transaction.hash,
            parentPostId,
          },
        );
        // Mark as not a comment if parent ID is invalid
        postTypeInfo.isComment = false;
        postTypeInfo.parentPostId = undefined;
      }
    }

    postTypeInfo.isBioUpdate = argument.value.some((arg) =>
      arg.value?.includes('bio-update'),
    );

    postTypeInfo.isHidden = argument.value.some((arg) =>
      arg.value?.includes('hidden'),
    );

    postTypeInfo.isBclSale = argument.value.some((arg) =>
      arg.value?.includes('bcl:'),
    );

    postTypeInfo.isBclTx = argument.value.some((arg) =>
      arg.value?.includes('bcl-tx:'),
    );

    postTypeInfo.isBclGain = argument.value.some((arg) =>
      arg.value?.includes('bcl-gain:'),
    );

    return postTypeInfo;
  }

  /**
   * Detects if a transaction represents a comment and extracts parent post information
   * @deprecated
   */
  private detectComment(transaction: ITransaction): ICommentInfo {
    if (!transaction?.tx?.arguments?.[1]?.value) {
      return { isComment: false };
    }

    const commentArgument = transaction.tx.arguments[1].value.find((arg) =>
      arg.value?.includes('comment:'),
    );

    if (!commentArgument?.value) {
      return { isComment: false };
    }

    const parentPostId = commentArgument.value.split('comment:')[1];
    if (!parentPostId || parentPostId.trim().length === 0) {
      this.logger.warn('Invalid comment format: missing parent post ID', {
        txHash: transaction.hash,
        commentValue: commentArgument.value,
      });
      return { isComment: false };
    }

    return {
      isComment: true,
      parentPostId: parentPostId.trim(),
      commentArgument,
    };
  }

  /**
   * Validates that a parent post exists for a comment with retry logic
   * This handles timing issues in parallel processing where parent posts
   * might be processed concurrently
   */
  private async validateParentPost(
    parentPostId: string,
    maxRetries: number = 3,
    retryDelay: number = 100,
  ): Promise<boolean> {
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
          return true;
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
          return false;
        }
      }
    }

    this.logger.warn('Parent post not found after all retries', {
      parentPostId,
      maxRetries,
    });
    return false;
  }

  /**
   * Processes comment-specific logic for existing posts
   */
  private async processExistingPostAsComment(
    existingPost: Post,
    postTypeInfo: IPostTypeInfo,
    txHash: string,
  ): Promise<ICommentProcessingResult> {
    if (!postTypeInfo.isComment || !postTypeInfo.parentPostId) {
      return { success: false, error: 'Invalid comment information' };
    }

    // Check if parent post exists
    const parentPostExists = await this.validateParentPost(
      postTypeInfo.parentPostId,
    );
    if (!parentPostExists) {
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
   * Updates the comment count for a parent post
   */
  private async updatePostCommentCount(parentPostId: string): Promise<void> {
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
   * Fixes orphaned comments by linking them to their parent posts
   * This is a cleanup method for comments that were created before their parent posts
   */
  async fixOrphanedComments(): Promise<void> {
    try {
      this.logger.log('Starting orphaned comments cleanup...');

      // Find comments that have a post_id but the parent post doesn't exist
      const orphanedComments = await this.postRepository
        .createQueryBuilder('comment')
        .leftJoin('posts', 'parent', 'parent.id = comment.post_id')
        .where('comment.post_id IS NOT NULL')
        .andWhere('parent.id IS NULL')
        .getMany();

      if (orphanedComments.length === 0) {
        this.logger.log('No orphaned comments found');
        return;
      }

      this.logger.log(`Found ${orphanedComments.length} orphaned comments`);

      let fixedCount = 0;
      for (const comment of orphanedComments) {
        try {
          // Check if parent post now exists
          const parentExists = await this.validateParentPost(
            comment.post_id,
            1,
            0,
          );
          if (parentExists) {
            // Update comment count for the parent
            await this.updatePostCommentCount(comment.post_id);
            fixedCount++;
          } else {
            // If parent still doesn't exist, remove the post_id to make it a regular post
            await this.postRepository.update(comment.id, { post_id: null });
            this.logger.warn('Converted orphaned comment to regular post', {
              commentId: comment.id,
              originalParentId: comment.post_id,
            });
          }
        } catch (error) {
          this.logger.error('Failed to fix orphaned comment', {
            commentId: comment.id,
            parentId: comment.post_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      this.logger.log(
        `Orphaned comments cleanup completed: ${fixedCount} fixed`,
      );
    } catch (error) {
      this.logger.error('Failed to run orphaned comments cleanup', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Creates or gets existing topics by name
   */
  private async createOrGetTopics(topicNames: string[]): Promise<Topic[]> {
    if (!topicNames || topicNames.length === 0) {
      return [];
    }

    const topics: Topic[] = [];

    for (const topicName of topicNames) {
      if (!topicName || topicName.trim().length === 0) {
        continue;
      }

      const normalizedName = topicName.trim().toLowerCase();

      // Try to find existing topic
      let topic = await this.topicRepository.findOne({
        where: { name: normalizedName },
      });

      // Create new topic if it doesn't exist
      if (!topic) {
        topic = this.topicRepository.create({
          name: normalizedName,
          post_count: 0,
          version: this.syncVersion,
        });
        topic = await this.topicRepository.save(topic);
        this.logger.debug('Created new topic', {
          topicName: normalizedName,
          version: this.syncVersion,
        });
      }

      topics.push(topic);
    }

    return topics;
  }

  /**
   * Updates the post count for topics
   */
  private async updateTopicPostCounts(topics: Topic[]): Promise<void> {
    for (const topic of topics) {
      try {
        const count = await this.postRepository
          .createQueryBuilder('post')
          .innerJoin('post.topics', 'topic')
          .where('topic.id = :topicId', { topicId: topic.id })
          .getCount();

        await this.topicRepository.update(topic.id, {
          post_count: count,
        });

        this.logger.debug('Updated topic post count', {
          topicId: topic.id,
          topicName: topic.name,
          postCount: count,
        });
      } catch (error) {
        this.logger.error('Failed to update topic post count', {
          topicId: topic.id,
          topicName: topic.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Clears posts and topics data with different syncVersion, handling foreign key constraints properly
   * This will only delete posts and topics that don't match the current syncVersion
   */
  private async clearNonCompatibleData(): Promise<void> {
    try {
      this.logger.log(
        `Clearing posts and topics data with syncVersion different from ${this.syncVersion}...`,
      );

      // Use a transaction to ensure data consistency
      await this.postRepository.manager.transaction(async (manager) => {
        // First, clear the junction table (post_topics) for posts with different syncVersion
        await manager.query(
          `
          DELETE FROM post_topics 
          WHERE post_id IN (
            SELECT id FROM posts WHERE version != $1
          )
        `,
          [this.syncVersion],
        );

        // Then clear topics with different syncVersion (no foreign key references)
        await manager.query('DELETE FROM topics WHERE version != $1', [
          this.syncVersion,
        ]);

        // Finally, clear posts with different syncVersion
        await manager.query('DELETE FROM posts WHERE version != $1', [
          this.syncVersion,
        ]);
      });

      this.logger.log(
        `Successfully cleared posts and topics data with syncVersion different from ${this.syncVersion}`,
      );
    } catch (error) {
      this.logger.error('Failed to clear posts and topics data', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

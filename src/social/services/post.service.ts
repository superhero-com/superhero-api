import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Post } from '../entities/post.entity';
import {
  ACTIVE_NETWORK,
  MAX_RETRIES_WHEN_REQUEST_FAILED,
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
} from '../interfaces/post.interfaces';
import { parsePostContent } from '../utils/content-parser.util';

@Injectable()
export class PostService {
  private readonly logger = new Logger(PostService.name);
  private readonly isProcessing = new Map<string, boolean>();

  constructor(
    @InjectRepository(Post)
    private readonly postRepository: Repository<Post>,
  ) {
    this.logger.log('PostService initialized');
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('Initializing PostService module...');
    try {
      await this.pullLatestPostsForContracts();
      this.logger.log('PostService module initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize PostService module', error);
      // Don't throw - allow the service to start even if initial sync fails
    }
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
        direction: 'backward',
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

      this.logger.log(
        `Pulling latest posts for contract ${contract.contractAddress}`,
        { url },
      );

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

    // Process transactions with better error handling
    const processingResults = await Promise.allSettled(
      result.data.map(async (transaction) => {
        try {
          const camelCasedTransaction = camelcaseKeysDeep(
            transaction,
          ) as ITransaction;
          const post = await this.savePostFromTransaction(
            camelCasedTransaction,
            contract,
          );
          return post;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          this.logger.warn('Failed to process individual transaction', {
            txHash: transaction?.hash,
            error: errorMessage,
          });
          throw error;
        }
      }),
    );

    // Collect successful results
    const successfulPosts = processingResults
      .filter(
        (result): result is PromiseFulfilledResult<any> =>
          result.status === 'fulfilled',
      )
      .map((result) => result.value)
      .filter((post) => post !== null);

    posts.push(...successfulPosts);

    const failedCount = processingResults.filter(
      (r) => r.status === 'rejected',
    ).length;
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

    try {
      // Check if post already exists
      const existingPost = await this.postRepository.findOne({
        where: { tx_hash: txHash },
      });

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

      // Parse content and extract metadata
      const parsedContent = parsePostContent(
        content,
        transaction.tx.arguments[1]?.value || [],
      );

      // Create post data with proper validation
      const postData: ICreatePostData = {
        id: this.generatePostId(transaction, contract),
        type: transaction.tx.function || 'unknown',
        tx_hash: txHash,
        sender_address: transaction.tx.callerId,
        contract_address: transaction.tx.contractId,
        content: parsedContent.content,
        topics: parsedContent.topics,
        media: parsedContent.media,
        total_comments: 0,
        tx_args: transaction.tx.arguments,
        created_at: moment(transaction.microTime).toDate(),
      };

      this.logger.debug('Creating new post', {
        txHash,
        postId: postData.id,
        topicsCount: postData.topics.length,
        mediaCount: postData.media.length,
      });

      // Use database transaction for consistency
      const post = await this.postRepository.manager.transaction(
        async (manager) => {
          const newPost = manager.create(Post, postData);
          return await manager.save(newPost);
        },
      );

      this.logger.log('Post saved successfully', {
        txHash,
        postId: post.id,
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
}

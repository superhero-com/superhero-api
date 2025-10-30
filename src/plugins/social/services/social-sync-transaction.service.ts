import { Account } from '@/plugins/account/entities/account.entity';
import { BasePluginSyncService } from '@/mdw-sync/plugins/base-plugin-sync.service';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Post } from '@/plugins/social/entities/post.entity';
import { Topic } from '@/plugins/social/entities/topic.entity';
import { parsePostContent } from '@/plugins/social/utils/content-parser.util';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import moment from 'moment';
import { Repository } from 'typeorm';
import {
  getContractByAddress,
  isContractSupported,
} from '../config/post-contracts.config';

@Injectable()
export class SocialSyncTransactionService extends BasePluginSyncService {
  protected readonly logger = new Logger(SocialSyncTransactionService.name);
  syncVersion = 5;

  constructor(
    @InjectRepository(Post)
    private readonly postRepository: Repository<Post>,
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
    @InjectRepository(Topic)
    private readonly topicRepository: Repository<Topic>,
  ) {
    super();
  }

  async processTransaction(tx: Tx): Promise<void> {
    if (!this.validateTransaction(tx) || !isContractSupported(tx.contract_id)) {
      return;
    }

    const contract = getContractByAddress(tx.contract_id);
    if (!contract) {
      this.logger.error('Contract configuration not found', {
        contractAddress: tx.contract_id,
      });
      return;
    }

    await this.savePostFromTransaction(tx, contract);
  }

  private validateTransaction(tx: Tx): boolean {
    if (!tx) {
      return false;
    }

    const requiredFields = ['tx_hash', 'micro_time'];
    for (const field of requiredFields) {
      if (!tx[field]) {
        this.logger.warn(`Transaction missing required field: ${field}`);
        return false;
      }
    }

    if (!tx.raw?.tx) {
      this.logger.warn('Transaction missing tx data');
      return false;
    }

    const requiredTxFields = ['callerId', 'contractId', 'arguments'];
    for (const field of requiredTxFields) {
      if (!tx.raw.tx[field]) {
        this.logger.warn(`Transaction.tx missing required field: ${field}`);
        return false;
      }
    }

    return true;
  }

  private async savePostFromTransaction(
    tx: Tx,
    contract: any,
  ): Promise<Post | null> {
    if (!this.validateTransaction(tx)) {
      this.logger.warn('Invalid transaction data', {
        hash: tx?.tx_hash,
      });
      return null;
    }

    const txHash = tx.tx_hash;

    // Check if post already exists
    const existingPost = await this.postRepository.findOne({
      where: { tx_hash: txHash },
    });

    if (existingPost) {
      return existingPost;
    }

    // Validate required transaction data
    if (!tx.raw.tx?.arguments?.[0]?.value) {
      this.logger.warn('Transaction missing content argument', { txHash });
      return null;
    }

    const content = tx.raw.tx.arguments[0].value;
    if (typeof content !== 'string' || content.trim().length === 0) {
      this.logger.warn('Invalid or empty content', { txHash });
      return null;
    }

    // Detect post type
    const postTypeInfo = this.detectPostType(tx);

    // Update or create the user account for bio updates
    if (postTypeInfo.isBioUpdate) {
      try {
        const account = await this.accountRepository.findOne({
          where: { address: tx.caller_id },
        });
        if (account) {
          await this.accountRepository.update(account.address, {
            bio: content,
          });
        } else {
          await this.accountRepository.save({
            address: tx.caller_id,
            bio: content,
          });
        }
      } catch (error: any) {
        this.logger.error('Error updating or creating account', error);
      }
    }

    // For new comments, validate parent post exists
    if (postTypeInfo.isComment && postTypeInfo.parentPostId) {
      const parentPostExists = await this.validateParentPost(
        postTypeInfo.parentPostId,
      );
      if (!parentPostExists) {
        this.logger.warn('Cannot create comment: parent post not found', {
          txHash,
          parentPostId: postTypeInfo.parentPostId,
        });
        // Convert to regular post instead of comment
        postTypeInfo.isComment = false;
        postTypeInfo.parentPostId = undefined;
        this.logger.log('Converting orphaned comment to regular post', {
          txHash,
          originalParentPostId: postTypeInfo.parentPostId,
        });
      }
    }

    // Parse content and extract metadata
    const parsedContent = parsePostContent(
      content,
      tx.raw.tx.arguments[1]?.value || [],
    );

    // Create or get topics
    const topics = await this.createOrGetTopics(parsedContent.topics);

    // Create post data
    const id = this.generatePostId(tx, contract);
    const slug = this.generatePostSlug(parsedContent.content, id);
    const postData = {
      id: id,
      slug: slug,
      type: tx.function || 'unknown',
      tx_hash: txHash,
      sender_address: tx.caller_id,
      contract_address: tx.contract_id,
      content: parsedContent.content,
      topics: topics,
      media: parsedContent.media,
      total_comments: 0,
      tx_args: tx.raw.tx.arguments,
      created_at: moment(tx.micro_time).toDate(),
      post_id:
        postTypeInfo.isComment && postTypeInfo.parentPostId
          ? postTypeInfo.parentPostId
          : null,
      is_hidden: postTypeInfo.isHidden,
      version: this.syncVersion,
    };

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
  }

  private generatePostId(tx: Tx, contract: any): string {
    const returnValue = tx.raw.tx?.return?.value;
    if (returnValue) {
      return `${returnValue}_v${contract.version}`;
    }

    // Fallback to hash-based ID if return value is not available
    return `${tx.tx_hash.slice(-8)}_v${contract.version}`;
  }

  private generatePostSlug(content: string, postId: string): string {
    const suffix = postId.split('_')[0];
    const base = this.normalizeSlugPart(content).slice(0, 30);
    const combined = base ? `${base}-${suffix}` : suffix;
    return combined.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  }

  private normalizeSlugPart(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}._~-]+/gu, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private detectPostType(tx: Tx): any {
    if (!tx.raw?.tx?.arguments?.[1]?.value) {
      return {
        isComment: false,
        isBioUpdate: false,
        isBclSale: false,
        isBclTx: false,
        isBclGain: false,
        isHidden: false,
      };
    }

    const argument = tx.raw.tx.arguments[1];
    const postTypeInfo = {
      isComment: false,
      isBioUpdate: false,
      isBclSale: false,
      isBclTx: false,
      isBclGain: false,
      isHidden: false,
      parentPostId: undefined as string | undefined,
    };

    postTypeInfo.isComment = argument.value.some((arg) =>
      arg.value?.includes('comment:'),
    );

    if (postTypeInfo.isComment) {
      const parentPostId = argument.value
        .find((arg) => arg.value?.includes('comment:'))
        ?.value?.split('comment:')[1];

      if (parentPostId && parentPostId.trim().length > 0) {
        postTypeInfo.parentPostId = parentPostId.trim();
        if (!parentPostId.endsWith('_v3')) {
          postTypeInfo.parentPostId = `${parentPostId}_v3`;
        }
      } else {
        this.logger.warn(
          'Invalid comment format: missing or empty parent post ID',
          {
            txHash: tx.tx_hash,
            parentPostId,
          },
        );
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

  private async validateParentPost(parentPostId: string): Promise<boolean> {
    try {
      const parentPost = await this.postRepository
        .createQueryBuilder('post')
        .where('post.id = :parentPostId', { parentPostId })
        .getOne();
      return !!parentPost;
    } catch (error: any) {
      this.logger.error('Error during parent post validation', {
        parentPostId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

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
      } catch (error: any) {
        this.logger.error('Failed to update topic post count', {
          topicId: topic.id,
          topicName: topic.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

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
    } catch (error: any) {
      this.logger.error('Failed to update comment count', {
        parentPostId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

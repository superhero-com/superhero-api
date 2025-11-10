import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Topic } from '@/social/entities/topic.entity';
import { Post } from '@/social/entities/post.entity';

@Injectable()
export class TopicManagementService {
  private readonly logger = new Logger(TopicManagementService.name);
  private readonly syncVersion = 6; // Match PostService syncVersion

  constructor(
    @InjectRepository(Topic)
    private readonly topicRepository: Repository<Topic>,
    @InjectRepository(Post)
    private readonly postRepository: Repository<Post>,
  ) {}

  /**
   * Creates or gets existing topics by name
   */
  async createOrGetTopics(topicNames: string[]): Promise<Topic[]> {
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
   * @param topics - Topics to update post counts for
   * @param manager - Optional EntityManager to use for transaction isolation
   */
  async updateTopicPostCounts(
    topics: Topic[],
    manager?: EntityManager,
  ): Promise<void> {
    // Use transaction manager's repositories if provided, otherwise use injected repositories
    const postRepository = manager
      ? manager.getRepository(Post)
      : this.postRepository;
    const topicRepository = manager
      ? manager.getRepository(Topic)
      : this.topicRepository;

    for (const topic of topics) {
      try {
        const count = await postRepository
          .createQueryBuilder('post')
          .innerJoin('post.topics', 'topic')
          .where('topic.id = :topicId', { topicId: topic.id })
          .getCount();

        await topicRepository.update(topic.id, {
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
}


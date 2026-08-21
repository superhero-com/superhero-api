import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, EntityManager } from 'typeorm';
import { randomUUID } from 'crypto';
import { Topic } from '@/social/entities/topic.entity';
import { Post } from '@/social/entities/post.entity';
import { normalizeTopicName } from '@/social/utils/topic-name.util';

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
   * Creates or gets existing topics by name.
   *
   * Bulk-upserts any missing topics in one round trip, then one IN() read,
   * instead of a sequential findOne+save per topic name. DO NOTHING (not
   * DO UPDATE) so an existing topic's accumulated post_count is never
   * clobbered by a same-named insert racing in from another post.
   *
   * Names are de-duplicated first: two raw names that normalize to the same
   * topic previously produced the same Topic twice in the returned array,
   * which the caller then fed into a ManyToMany relation.
   */
  async createOrGetTopics(topicNames: string[]): Promise<Topic[]> {
    const normalizedNames = [
      ...new Set(
        (topicNames || [])
          .filter((topicName) => topicName && topicName.trim().length > 0)
          .map((topicName) => normalizeTopicName(topicName)),
      ),
    ];

    if (normalizedNames.length === 0) {
      return [];
    }

    await this.topicRepository.query(
      `
        INSERT INTO topics (id, name, post_count, version, created_at, updated_at)
        SELECT unnest($1::uuid[]), unnest($2::text[]), 0, $3, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)
        ON CONFLICT (name) DO NOTHING
      `,
      [
        normalizedNames.map(() => randomUUID()),
        normalizedNames,
        this.syncVersion,
      ],
    );

    const topics = await this.topicRepository.find({
      where: { name: In(normalizedNames) },
    });

    const topicByName = new Map(topics.map((topic) => [topic.name, topic]));
    const orderedTopics = normalizedNames
      .map((name) => topicByName.get(name))
      .filter((topic): topic is Topic => Boolean(topic));

    if (orderedTopics.length !== normalizedNames.length) {
      this.logger.warn('Some topics could not be created or found', {
        requested: normalizedNames,
        resolved: orderedTopics.map((topic) => topic.name),
      });
    }

    return orderedTopics;
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

    if (topics.length === 0) {
      return;
    }

    // One grouped read for every topic instead of a getCount() per topic.
    // The rows counted are the same either way -- this collapses the round
    // trips, it does not make the count itself cheaper.
    let countByTopicId = new Map<string, number>();
    try {
      const rows = await postRepository
        .createQueryBuilder('post')
        .innerJoin('post.topics', 'topic')
        .select('topic.id', 'topic_id')
        .addSelect('COUNT(post.id)', 'count')
        .where('topic.id IN (:...topicIds)', {
          topicIds: topics.map((topic) => topic.id),
        })
        .groupBy('topic.id')
        .getRawMany<{ topic_id: string; count: string }>();
      countByTopicId = new Map(
        rows.map((row) => [row.topic_id, parseInt(row.count, 10)]),
      );
    } catch (error) {
      this.logger.error('Failed to load topic post counts', {
        topicIds: topics.map((topic) => topic.id),
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    for (const topic of topics) {
      try {
        const count = countByTopicId.get(topic.id) ?? 0;

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

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PopularRankingContributor, PopularRankingContentItem } from '@/plugins/popular-ranking.interface';
import { PopularWindow } from '@/social/services/popular-ranking.service';
import { GovernancePoll } from '../entities/governance-poll.view';

@Injectable()
export class GovernancePopularRankingService implements PopularRankingContributor {
  readonly name = 'poll';
  private readonly logger = new Logger(GovernancePopularRankingService.name);

  constructor(
    @InjectRepository(GovernancePoll)
    private readonly pollRepository: Repository<GovernancePoll>,
  ) {}

  async getRankingCandidates(
    window: PopularWindow,
    since: Date | null,
    limit: number,
  ): Promise<PopularRankingContentItem[]> {
    try {
      const queryBuilder = this.pollRepository
        .createQueryBuilder('poll')
        .orderBy('poll.created_at', 'DESC')
        .limit(limit);

      // Apply time window filter
      if (since) {
        queryBuilder.where('poll.created_at >= :since', { since });
      }

      const polls = await queryBuilder.getMany();

      return polls.map((poll) => {
        const metadata = poll.metadata || ({} as { title?: string; description?: string });
        const title = metadata.title || 'Untitled poll';
        const description = metadata.description || '';
        const content = `${title}${description ? ` - ${description}` : ''}`;

        // Extract topics from metadata if available
        const topics: Array<{ name: string }> = [];
        // Could extract topics from description or link if needed

        return {
          id: `poll:${poll.poll_seq_id || poll.hash}`,
          type: 'poll',
          created_at: poll.created_at,
          sender_address: poll.author || poll.caller_id || '',
          content,
          total_comments: poll.votes_count || 0, // Use votes_count as engagement metric
          topics,
          metadata: {
            poll_address: poll.poll_address,
            poll_seq_id: poll.poll_seq_id,
            hash: poll.hash,
            close_height: poll.close_height,
            create_height: poll.create_height,
            vote_options: poll.vote_options,
            votes_count: poll.votes_count,
            votes_count_by_option: poll.votes_count_by_option,
          },
        };
      });
    } catch (error) {
      this.logger.error(`Failed to fetch polls for popular ranking:`, error);
      return [];
    }
  }
}


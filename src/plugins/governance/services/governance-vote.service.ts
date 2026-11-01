import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  IPaginationOptions,
  paginate,
  Pagination,
} from 'nestjs-typeorm-paginate';
import { GovernancePoll } from '../entities/governance-poll.view';
import { GovernancePollVote } from '../entities/governance-poll-vote.view';
import {
  GovernancePollDto,
  GovernanceVoteDto,
} from '../dto/governance-vote.dto';

export type GovernancePollStatus = 'open' | 'closed' | 'all';

@Injectable()
export class GovernanceVoteService {
  constructor(
    @InjectRepository(GovernancePoll)
    private readonly pollRepository: Repository<GovernancePoll>,
    @InjectRepository(GovernancePollVote)
    private readonly voteRepository: Repository<GovernancePollVote>,
  ) {}

  /**
   * List polls, newest first. `status` filters on close height against
   * `currentHeight`: open = no close height or closing after it, closed =
   * closed at or before it.
   */
  async findAll(
    options: IPaginationOptions,
    filter: {
      status?: GovernancePollStatus;
      currentHeight?: number;
      author?: string;
    } = {},
  ): Promise<Pagination<GovernancePollDto>> {
    const query = this.pollRepository
      .createQueryBuilder('poll')
      .orderBy('poll.block_height', 'DESC')
      .addOrderBy('poll.hash', 'ASC');

    const closeExpr = 'COALESCE(poll.close_at_height, poll.close_height)';
    if (filter.status && filter.status !== 'all' && filter.currentHeight) {
      if (filter.status === 'open') {
        query.andWhere(`(${closeExpr} IS NULL OR ${closeExpr} > :height)`, {
          height: filter.currentHeight,
        });
      } else {
        query.andWhere(`${closeExpr} <= :height`, {
          height: filter.currentHeight,
        });
      }
    }
    if (filter.author) {
      query.andWhere('poll.author = :author', { author: filter.author });
    }

    return paginate(query, options);
  }

  async findOne(pollAddress: string): Promise<GovernanceVoteDto> {
    const poll = await this.pollRepository.findOne({
      where: { poll_address: pollAddress },
    });

    if (!poll) {
      throw new NotFoundException(`Poll with address ${pollAddress} not found`);
    }

    const votes = await this.voteRepository.find({
      where: { poll_address: pollAddress },
      order: { created_at: 'ASC' },
    });

    return {
      poll,
      votes,
    };
  }
}

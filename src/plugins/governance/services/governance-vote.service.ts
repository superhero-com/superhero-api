import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  IPaginationOptions,
  paginate,
  Pagination,
} from 'nestjs-typeorm-paginate';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { GovernancePoll } from '../entities/governance-poll.view';
import { GovernancePollVote } from '../entities/governance-poll-vote.view';
import {
  GovernancePollDto,
  GovernanceVoteDto,
} from '../dto/governance-vote.dto';

export enum GovernancePollStatus {
  Open = 'open',
  Closed = 'closed',
  All = 'all',
}

@Injectable()
export class GovernanceVoteService {
  constructor(
    @InjectRepository(GovernancePoll)
    private readonly pollRepository: Repository<GovernancePoll>,
    @InjectRepository(GovernancePollVote)
    private readonly voteRepository: Repository<GovernancePollVote>,
    private readonly aeSdkService: AeSdkService,
  ) {}

  /**
   * List polls, newest first. `status` compares the close height with the
   * current height: open = no close height or closing after it, closed =
   * closed at or before it.
   */
  async findAll(
    options: IPaginationOptions,
    filter: {
      status?: GovernancePollStatus;
      author?: string;
    } = {},
  ): Promise<Pagination<GovernancePollDto>> {
    const query = this.pollRepository
      .createQueryBuilder('poll')
      .orderBy('poll.block_height', 'DESC')
      .addOrderBy('poll.hash', 'ASC');

    if (filter.status && filter.status !== GovernancePollStatus.All) {
      const height = await this.aeSdkService.sdk.getHeight();
      query.andWhere(
        filter.status === GovernancePollStatus.Open
          ? '(poll.close_height IS NULL OR poll.close_height > :height)'
          : 'poll.close_height <= :height',
        { height },
      );
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

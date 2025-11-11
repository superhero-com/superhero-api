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
  GovernancePollVoteDto,
  GovernanceVoteDto,
} from '../dto/governance-vote.dto';

@Injectable()
export class GovernanceVoteService {
  constructor(
    @InjectRepository(GovernancePoll)
    private readonly pollRepository: Repository<GovernancePoll>,
    @InjectRepository(GovernancePollVote)
    private readonly voteRepository: Repository<GovernancePollVote>,
  ) {}

  async findAll(
    options: IPaginationOptions,
  ): Promise<Pagination<GovernancePollDto>> {
    const query = this.pollRepository
      .createQueryBuilder('poll')
      .orderBy('poll.hash', 'ASC');

    return paginate(query, options);
  }

  async findOne(pollAddress: string): Promise<GovernanceVoteDto> {
    const poll = await this.pollRepository.findOne({
      where: { poll_address: pollAddress },
    });

    if (!poll) {
      throw new NotFoundException(
        `Poll with address ${pollAddress} not found`,
      );
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


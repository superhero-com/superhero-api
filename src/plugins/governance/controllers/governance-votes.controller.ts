import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { GovernanceVoteService } from '../services/governance-vote.service';
import {
  GovernancePollDto,
  GovernanceVoteDto,
} from '../dto/governance-vote.dto';
import { ApiOkResponsePaginated } from '@/utils/api-type';
import { Pagination } from 'nestjs-typeorm-paginate';

@Controller('governance/votes')
@ApiTags('Governance')
export class GovernanceVotesController {
  constructor(
    private readonly governanceVoteService: GovernanceVoteService,
  ) {}

  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiOperation({
    operationId: 'listGovernancePolls',
    summary: 'Get all governance polls',
    description:
      'Retrieve a paginated list of governance polls',
  })
  @ApiOkResponsePaginated(GovernancePollDto)
  @Get()
  async findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
  ): Promise<Pagination<GovernancePollDto>> {
    return this.governanceVoteService.findAll({ page, limit });
  }

  @ApiParam({
    name: 'pollAddress',
    description: 'The poll address to retrieve votes for',
    type: String,
  })
  @ApiOperation({
    operationId: 'getGovernancePollWithVotes',
    summary: 'Get a governance poll with its votes',
    description:
      'Retrieve a single governance poll by poll address with all associated votes',
  })
  @Get(':pollAddress')
  async findOne(
    @Param('pollAddress') pollAddress: string,
  ): Promise<GovernanceVoteDto> {
    return this.governanceVoteService.findOne(pollAddress);
  }
}


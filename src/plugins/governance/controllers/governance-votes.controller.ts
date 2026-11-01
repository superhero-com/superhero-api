import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  GovernancePollStatus,
  GovernanceVoteService,
} from '../services/governance-vote.service';
import {
  GovernancePollDto,
  GovernanceVoteDto,
} from '../dto/governance-vote.dto';
import { ApiOkResponsePaginated } from '@/utils/api-type';
import { Pagination } from 'nestjs-typeorm-paginate';
import {
  AeContractAddressPipe,
  OptionalAeAccountAddressPipe,
} from '@/common/validation/request-validation';
import { AeSdkService } from '@/ae/ae-sdk.service';

const POLL_STATUSES: GovernancePollStatus[] = ['open', 'closed', 'all'];

@Controller('governance/votes')
@ApiTags('Governance')
export class GovernanceVotesController {
  constructor(
    private readonly governanceVoteService: GovernanceVoteService,
    private readonly aeSdkService: AeSdkService,
  ) {}

  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'status',
    enum: POLL_STATUSES,
    required: false,
    description: 'Filter by open or closed polls (default all)',
  })
  @ApiQuery({
    name: 'author',
    type: String,
    required: false,
    description: 'Only polls created by this account',
  })
  @ApiOperation({
    operationId: 'listGovernancePolls',
    summary: 'Get all governance polls',
    description: 'Retrieve a paginated list of governance polls, newest first',
  })
  @ApiOkResponsePaginated(GovernancePollDto)
  @Get()
  async findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('status') status?: string,
    @Query('author', OptionalAeAccountAddressPipe) author?: string,
  ): Promise<Pagination<GovernancePollDto>> {
    const normalized = (status || 'all').toLowerCase() as GovernancePollStatus;
    if (!POLL_STATUSES.includes(normalized)) {
      throw new BadRequestException(
        `status must be one of ${POLL_STATUSES.join(', ')}`,
      );
    }
    const currentHeight =
      normalized === 'all'
        ? undefined
        : await this.aeSdkService.sdk.getHeight();
    return this.governanceVoteService.findAll(
      { page, limit },
      { status: normalized, currentHeight, author },
    );
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
    @Param('pollAddress', AeContractAddressPipe) pollAddress: string,
  ): Promise<GovernanceVoteDto> {
    return this.governanceVoteService.findOne(pollAddress);
  }
}

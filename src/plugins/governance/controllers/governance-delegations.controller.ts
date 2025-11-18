import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { GovernanceDelegationService } from '../services/governance-delegation.service';
import {
  GovernanceDelegationWithRevokedDto,
  GovernanceDelegationHistoryItemDto,
} from '../dto/governance-delegation.dto';
import { ApiOkResponsePaginated } from '@/utils/api-type';
import { Pagination } from 'nestjs-typeorm-paginate';

@Controller('governance/delegations')
@ApiTags('Governance')
export class GovernanceDelegationsController {
  constructor(
    private readonly governanceDelegationService: GovernanceDelegationService,
  ) {}

  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'includeRevoked',
    type: 'boolean',
    required: false,
    description: 'Include revoked delegations in the results',
  })
  @ApiOperation({
    operationId: 'listGovernanceDelegations',
    summary: 'Get all governance delegations',
    description:
      'Retrieve a paginated list of governance delegations. By default, only valid (non-revoked) delegations are returned.',
  })
  @ApiOkResponsePaginated(GovernanceDelegationWithRevokedDto)
  @Get()
  async findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('includeRevoked', new DefaultValuePipe(false), ParseBoolPipe)
    includeRevoked = false,
  ): Promise<Pagination<GovernanceDelegationWithRevokedDto>> {
    return this.governanceDelegationService.findAll(
      { page, limit },
      includeRevoked,
    );
  }

  @ApiParam({
    name: 'accountAddress',
    description: 'The account address to retrieve delegation history for',
    type: String,
  })
  @ApiOperation({
    operationId: 'getGovernanceDelegationHistory',
    summary: 'Get delegation history for an account',
    description:
      'Retrieve all delegation and revocation transactions for a specific account address, ordered chronologically',
  })
  @Get(':accountAddress')
  async findHistoryByAccount(
    @Param('accountAddress') accountAddress: string,
  ): Promise<GovernanceDelegationHistoryItemDto[]> {
    return this.governanceDelegationService.findHistoryByAccount(accountAddress);
  }
}


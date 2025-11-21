import {
  Controller,
  DefaultValuePipe,
  Get,
  HttpStatus,
  NotFoundException,
  Param,
  ParseEnumPipe,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { BclTokensService } from '../services/bcl-tokens.service';
import { BclTokenDto } from '../dto/bcl-token.dto';
import { ApiOkResponsePaginated } from '@/utils/api-type';
import { Pagination } from 'nestjs-typeorm-paginate';

@Controller('bcl/tokens')
@ApiTags('BCL')
export class BclTokensController {
  constructor(
    private readonly bclTokensService: BclTokensService,
  ) {}

  @ApiQuery({
    name: 'search',
    type: 'string',
    description: 'Search tokens by name',
    required: false,
  })
  @ApiQuery({
    name: 'factory_address',
    type: 'string',
    description: 'Filter by factory address',
    required: false,
  })
  @ApiQuery({
    name: 'creator_address',
    type: 'string',
    description: 'Filter tokens created by this account address',
    required: false,
  })
  @ApiQuery({
    name: 'owner_address',
    type: 'string',
    description: 'Filter tokens owned by this account address',
    required: false,
  })
  @ApiQuery({
    name: 'collection',
    enum: ['all', 'word', 'number'],
    description: 'Filter by collection type',
    required: false,
  })
  @ApiQuery({
    name: 'unlisted',
    type: 'boolean',
    description: 'Filter by unlisted status',
    required: false,
  })
  @ApiQuery({
    name: 'page',
    type: 'number',
    required: false,
  })
  @ApiQuery({
    name: 'limit',
    type: 'number',
    required: false,
  })
  @ApiQuery({
    name: 'order_by',
    enum: ['rank', 'market_cap', 'name', 'price', 'created_at', 'trending_score', 'tx_count', 'holders_count'],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiOperation({
    operationId: 'findAllTokens',
    summary: 'Get all BCL tokens',
    description:
      'Retrieve a paginated list of BCL tokens with latest pricing and statistics',
  })
  @ApiOkResponsePaginated(BclTokenDto)
  @Get()
  async findAllTokens(
    @Query('search') search?: string,
    @Query('factory_address') factory_address?: string,
    @Query('creator_address') creator_address?: string,
    @Query('owner_address') owner_address?: string,
    @Query('collection') collection: 'all' | 'word' | 'number' = 'all',
    @Query('unlisted') unlisted?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'market_cap',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
  ): Promise<Pagination<BclTokenDto> & { queryMs: number }> {
    const unlistedBool = unlisted !== undefined ? unlisted === 'true' : undefined;
    
    // Validate sort fields to avoid SQL Injection
    const allowedSortFields = [
      'rank',
      'market_cap',
      'name',
      'price',
      'created_at',
      'trending_score',
      'tx_count',
      'holders_count',
    ];
    if (!allowedSortFields.includes(orderBy)) {
      orderBy = 'market_cap';
    }
    const allowedOrderDirections = ['ASC', 'DESC'];
    if (!allowedOrderDirections.includes(orderDirection)) {
      orderDirection = 'DESC';
    }
    
    return this.bclTokensService.findAll(
      { page, limit },
      {
        search,
        factory_address,
        creator_address,
        owner_address,
        collection,
        unlisted: unlistedBool,
      },
      orderBy,
      orderDirection,
    );
  }

  @ApiOperation({ operationId: 'findTokenByAddress' })
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address, sale address, name, or symbol',
  })
  @ApiResponse({
    type: BclTokenDto,
    status: HttpStatus.OK,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Token not found',
  })
  @Get(':address')
  async findTokenByAddress(@Param('address') address: string): Promise<BclTokenDto> {
    const token = await this.bclTokensService.findByAddress(address);
    if (!token) {
      throw new NotFoundException(`Token with address ${address} not found`);
    }
    return token;
  }
}


import {
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Pagination } from 'nestjs-typeorm-paginate';
import { ApiOkResponsePaginated } from '@/utils/api-type';
import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import { BclTokensService } from '@/plugins/bcl/services/bcl-tokens.service';
import { BclTokenDto } from '@/plugins/bcl/dto/bcl-token.dto';
import { TokenDto } from '@/tokens/dto/token.dto';
import BigNumber from 'bignumber.js';

@Controller('tokens')
@UseInterceptors(CacheInterceptor)
@ApiTags('Tokens')
export class DeprecatedTokensController {
  constructor(
    private readonly bclTokensService: BclTokensService,
  ) {
    //
  }

  @ApiQuery({ name: 'search', type: 'string', required: false })
  @ApiQuery({ name: 'factory_address', type: 'string', required: false })
  @ApiQuery({ name: 'creator_address', type: 'string', required: false })
  @ApiQuery({ name: 'owner_address', type: 'string', required: false })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'order_by',
    enum: ['name', 'price', 'market_cap', 'created_at', 'holders_count'],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiQuery({
    name: 'collection',
    enum: ['all', 'word', 'number'],
    required: false,
  })
  @ApiOperation({
    operationId: 'listAll',
    deprecated: true,
    description: 'This endpoint is deprecated. Use /bcl/tokens instead.',
  })
  @ApiOkResponsePaginated(TokenDto)
  @CacheTTL(10)
  @Get()
  async listAll(
    @Query('search') search = undefined,
    @Query('factory_address') factory_address = undefined,
    @Query('creator_address') creator_address = undefined,
    @Query('owner_address') owner_address = undefined,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'rank',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'ASC',
    @Query('collection') collection: 'all' | 'word' | 'number' = 'all',
  ): Promise<Pagination<BclTokenDto> & { queryMs?: number }> {

    const bclSortBy = orderBy;
    const allowedOrderDirections = ['ASC', 'DESC'];
    if (!allowedOrderDirections.includes(orderDirection)) {
      orderDirection = 'DESC';
    }
    const bclOrder = orderDirection;

    return this.bclTokensService.findAll(
      { page, limit },
      {
        search,
        factory_address,
        creator_address,
        owner_address,
        collection: collection !== 'all' ? collection : undefined,
        unlisted: false,
      },
      bclSortBy,
      bclOrder,
    );
  }

  @ApiOperation({
    operationId: 'findByAddress',
    deprecated: true,
    description: 'This endpoint is deprecated. Use /bcl/tokens/:address instead.',
  })
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address or name',
  })
  @Get(':address')
  @CacheTTL(3)
  @ApiResponse({
    type: TokenDto,
  })
  async findByAddress(@Param('address') address: string): Promise<BclTokenDto | null> {
    const token = await this.bclTokensService.findByAddress(address);

    if (!token) {
      throw new NotFoundException('Token not found');
    }
    return token;
  }
}


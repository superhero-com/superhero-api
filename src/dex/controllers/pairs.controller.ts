import {
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiOkResponse,
} from '@nestjs/swagger';
import { PairService } from '../services/pair.service';
import { PairDto } from '../dto';
import { ApiOkResponsePaginated } from '@/utils/api-type';

@Controller('dex/pairs')
@ApiTags('DEX')
export class PairsController {
  constructor(private readonly pairService: PairService) {}

  @ApiQuery({
    name: 'search',
    type: 'string',
    required: false,
    description: 'Search pairs by token name or symbol',
  })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'order_by',
    enum: ['transactions_count', 'created_at'],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiOperation({
    operationId: 'listAllPairs',
    summary: 'Get all pairs',
    description:
      'Retrieve a paginated list of all DEX pairs with optional sorting and search by token name or symbol',
  })
  @ApiOkResponsePaginated(PairDto)
  @Get()
  async listAll(
    @Query('search') search = undefined,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'created_at',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
  ) {
    return this.pairService.findAll(
      { page, limit },
      orderBy,
      orderDirection,
      search,
    );
  }

  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Pair contract address',
  })
  @ApiOperation({
    operationId: 'getPairByAddress',
    summary: 'Get pair by address',
    description: 'Retrieve a specific pair by its contract address',
  })
  @ApiOkResponse({ type: PairDto })
  @Get(':address')
  async getByAddress(@Param('address') address: string) {
    const pair = await this.pairService.findByAddress(address);
    if (!pair) {
      throw new NotFoundException(`Pair with address ${address} not found`);
    }
    return pair;
  }
}

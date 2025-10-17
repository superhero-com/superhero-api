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
import { PairDto, PairSummaryDto } from '../dto';
import { ApiOkResponsePaginated } from '@/utils/api-type';
import { PairHistoryService } from '../services/pair-history.service';

@Controller('dex/pairs')
@ApiTags('DEX')
export class PairsController {
  constructor(
    private readonly pairService: PairService,
    private readonly pairHistoryService: PairHistoryService,
  ) {}

  @ApiQuery({
    name: 'search',
    type: 'string',
    required: false,
    description: 'Search pairs by token name or symbol',
  })
  @ApiQuery({
    name: 'token_address',
    type: 'string',
    required: false,
    description: 'Search by token address',
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
    @Query('token_address') token_address = undefined,
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
      token_address,
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

  @ApiParam({
    name: 'from_token',
    type: 'string',
    description: 'Token address',
  })
  @ApiParam({
    name: 'to_token',
    type: 'string',
    description: 'Token address',
  })
  @ApiOperation({
    operationId: 'getPairByFromTokenAndToToken',
    summary: 'Get pair by from token and to token',
    description: 'Retrieve a specific pair by its contract address',
  })
  @ApiOkResponse({ type: PairDto })
  @Get('from/:from_token/to/:to_token')
  async getPairByFromTokenAndToToken(
    @Param('from_token') fromToken: string,
    @Param('to_token') toToken: string,
  ) {
    const pair = await this.pairService.findByFromTokenAndToToken(
      fromToken,
      toToken,
    );
    if (!pair) {
      throw new NotFoundException(
        `Pair with from token ${fromToken} and to token ${toToken} not found`,
      );
    }
    return pair;
  }

  @ApiOperation({ operationId: 'getPaginatedHistory' })
  @ApiQuery({
    name: 'interval',
    type: 'number',
    description: 'Interval type in seconds, default is 3600 (1 hour)',
    required: false,
  })
  @ApiQuery({
    name: 'from_token',
    enum: ['token0', 'token1'],
    required: false,
  })
  @ApiQuery({
    name: 'convertTo',
    enum: ['ae', 'usd', 'eur', 'aud', 'brl', 'cad', 'chf', 'gbp', 'xau'],
    required: false,
  })
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address or name',
  })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @Get(':address/history')
  async getPaginatedHistory(
    @Param('address') address: string,
    @Query('interval') interval: number = 3600,
    @Query('from_token') fromToken: string = 'token0',
    @Query('convertTo') convertTo: string = 'ae',
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
  ) {
    const pair = await this.pairService.findByAddress(address);
    return this.pairHistoryService.getPaginatedHistoricalData({
      pair,
      interval,
      fromToken,
      convertTo,
      page,
      limit,
    });
  }

  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Pair contract address',
  })
  @ApiQuery({
    name: 'token',
    type: 'string',
    required: false,
    description:
      'Token address to use as base for volume calculations (token0 or token1). If not provided, defaults to WAE if one of the tokens is WAE',
  })
  @ApiOperation({
    operationId: 'getPairSummary',
    summary: 'Get pair summary',
    description:
      'Get comprehensive summary data for a pair including volume, locked value, and price changes. Volume calculations can be based on token0, token1, or default to WAE if available.',
  })
  @ApiOkResponse({ type: PairSummaryDto })
  @Get(':address/summary')
  async getPairSummary(
    @Param('address') address: string,
    @Query('token') token?: string,
  ) {
    const pair = await this.pairService.findByAddress(address);
    if (!pair) {
      throw new NotFoundException(`Pair with address ${address} not found`);
    }
    const summary = await this.pairHistoryService.getPairSummary(pair, token);
    return {
      ...summary,
      pair,
    };
  }
}

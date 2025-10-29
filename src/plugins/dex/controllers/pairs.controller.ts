import {
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiOkResponse,
} from '@nestjs/swagger';
import { PairService } from '@/dex/services/pair.service';
import { PairDto, PairSummaryDto, PairWithSummaryDto } from '@/dex/dto';
import { ApiOkResponsePaginated } from '@/utils/api-type';
import {
  PairHistoryService,
  ITransactionPreview,
} from '@/dex/services/pair-history.service';
import { PairSummaryService } from '@/dex/services/pair-summary.service';

@Controller('dex/pairs')
@ApiTags('Dex Pair')
export class PairsController {
  constructor(
    private readonly pairService: PairService,
    private readonly pairHistoryService: PairHistoryService,
    private readonly pairSummaryService: PairSummaryService,
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
  @ApiOkResponsePaginated(PairWithSummaryDto)
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
    operationId: 'findPairsForTokens',
    summary: 'Get all possible swap paths between two tokens',
    description:
      'Find all possible swap paths from one token to another, including direct pairs and multi-hop paths',
  })
  @ApiOkResponse({
    type: Object,
    description:
      'Returns all possible swap paths with direct pairs and multi-hop paths',
  })
  @Get('from/:from_token/to/:to_token/providers')
  async findPairsForTokens(
    @Param('from_token') fromToken: string,
    @Param('to_token') toToken: string,
  ) {
    const result = await this.pairService.findSwapPaths(fromToken, toToken);

    if (result.paths.length === 0) {
      throw new NotFoundException(
        `No swap paths found from token ${fromToken} to token ${toToken}`,
      );
    }

    return {
      ...result,
      hasDirectPath: result.directPairs.length > 0,
      totalPaths: result.paths.length,
    };
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
    const summary = await this.pairSummaryService.createOrUpdateSummary(
      pair,
      token,
    );
    return {
      ...summary,
      pair,
    };
  }

  @ApiOperation({ operationId: 'getPairPreview' })
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Pair contract address',
  })
  @ApiQuery({
    name: 'interval',
    enum: ['1d', '7d', '30d'],
    required: false,
    example: '7d',
  })
  @ApiOkResponse({ type: Object })
  @Get('/:address/preview')
  async getForPreview(
    @Param('address') address: string,
    @Query('interval') interval: '1d' | '7d' | '30d' = '7d',
  ): Promise<ITransactionPreview> {
    if (!address || address == 'null') {
      throw new BadRequestException('Address is required');
    }
    const pair = await this.pairService.findByAddress(address);
    if (!pair) {
      throw new NotFoundException(`Pair with address ${address} not found`);
    }
    return this.pairHistoryService.getForPreview(pair, interval);
  }
}



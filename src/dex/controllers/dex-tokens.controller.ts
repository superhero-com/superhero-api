import { ApiOkResponsePaginated } from '@/utils/api-type';
import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { ApiKeyGuard } from '@/trending-tags/guards/api-key.guard';
import { SetListedDto } from '../dto/set-listed.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DexTokenDto, DexTokenSummaryDto } from '../dto';
import { Pair } from '../entities/pair.entity';
import { DexTokenSummaryService } from '../services/dex-token-summary.service';
import { DexTokenService } from '../services/dex-token.service';
import { PairHistoryService } from '../services/pair-history.service';
import {
  AeContractAddressPipe,
  OptionalAeContractAddressPipe,
} from '@/common/validation/request-validation';

const MIN_HISTORY_INTERVAL_SECONDS = 60;
const MAX_HISTORY_INTERVAL_SECONDS = 86_400;

/**
 * Parse the optional ?listed query param into a boolean filter.
 * Accepts 'true'/'1' (→ true) and 'false'/'0' (→ false), case-insensitively,
 * and returns undefined when the param is omitted. Any other value throws a
 * 400 instead of being silently coerced to a (wrong) filter.
 */
function parseListedFilter(value?: string): boolean | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }
  throw new BadRequestException(
    `Invalid listed value: ${value}. Expected 'true' or 'false'.`,
  );
}

@Controller('dex/tokens')
@ApiTags('DEX')
export class DexTokensController {
  constructor(
    private readonly dexTokenService: DexTokenService,
    @InjectRepository(Pair)
    private readonly pairRepository: Repository<Pair>,
    private readonly dexTokenSummaryService: DexTokenSummaryService,
    private readonly pairHistoryService: PairHistoryService,
  ) {
    //
  }

  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({ name: 'search', type: 'string', required: false })
  @ApiQuery({
    name: 'order_by',
    enum: [
      'pairs_count',
      'name',
      'symbol',
      'created_at',
      'price',
      'tvl',
      '24hchange',
      '24hvolume',
      '7dchange',
      '7dvolume',
      '30dchange',
      '30dvolume',
    ],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiQuery({
    name: 'listed',
    type: 'boolean',
    required: false,
    description:
      'Filter to only listed (true) or only unlisted (false) tokens. Omit to return all tokens.',
  })
  @ApiOperation({
    operationId: 'listAllDexTokens',
    summary: 'Get all DEX tokens',
    description:
      'Retrieve a paginated list of all DEX tokens with optional sorting',
  })
  @ApiOkResponsePaginated(DexTokenDto)
  @Get()
  async listAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('search') search = '',
    @Query('order_by') orderBy: string = 'created_at',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
    @Query('listed') listed?: string,
  ) {
    return this.dexTokenService.findAll(
      { page, limit },
      search,
      orderBy,
      orderDirection,
      parseListedFilter(listed),
    );
  }

  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token contract address',
  })
  @ApiOperation({
    operationId: 'getDexTokenByAddress',
    summary: 'Get DEX token by address',
    description: 'Retrieve a specific DEX token by its contract address',
  })
  @ApiOkResponse({ type: DexTokenDto })
  @Get(':address')
  async getByAddress(@Param('address', AeContractAddressPipe) address: string) {
    const token = await this.dexTokenService.findByAddress(address);
    if (!token) {
      throw new NotFoundException(
        `DEX token with address ${address} not found`,
      );
    }
    return token;
  }

  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token contract address',
  })
  @ApiOperation({
    operationId: 'getTokenPrice',
    summary: 'Get DEX token price',
    description:
      'Retrieve a token together with its current price and price metadata.',
  })
  @ApiOkResponse({
    description: 'The token plus its price and price metadata',
    schema: {
      type: 'object',
      properties: {
        price: {
          type: 'string',
          description: 'Best price found',
          nullable: true,
        },
        token: { $ref: '#/components/schemas/DexTokenDto' },
      },
      additionalProperties: true,
    },
  })
  @Get(':address/price')
  async getTokenPrice(
    @Param('address', AeContractAddressPipe) address: string,
  ) {
    const token = await this.dexTokenService.findByAddress(address);
    if (!token) {
      throw new NotFoundException(
        `DEX token with address ${address} not found`,
      );
    }
    const { price, ...data } = await this.dexTokenService.getTokenPrice(
      address,
      true,
    );
    return { price: price, token, ...data };
  }

  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token contract address',
  })
  @ApiQuery({
    name: 'base_token',
    type: 'string',
    required: false,
    description: 'Base token for price calculation (default: WAE)',
  })
  @ApiQuery({
    name: 'debug',
    type: 'boolean',
    required: false,
    description: 'Include detailed path analysis',
  })
  @ApiOperation({
    operationId: 'getTokenPriceWithLiquidityAnalysis',
    summary: 'Get comprehensive token price analysis',
    description:
      'Get detailed price analysis including liquidity-weighted pricing, confidence metrics, and all possible paths',
  })
  @ApiOkResponse({
    type: Object,
    description: 'Comprehensive price analysis with liquidity weighting',
    schema: {
      type: 'object',
      properties: {
        price: { type: 'string', description: 'Best price found' },
        confidence: { type: 'number', description: 'Price confidence (0-1)' },
        bestPath: {
          type: 'array',
          items: { $ref: '#/components/schemas/PairDto' },
          description: 'Best liquidity path',
        },
        allPaths: {
          type: 'array',
          description: 'All possible paths with analysis',
        },
        liquidityWeightedPrice: {
          type: 'string',
          description: 'Liquidity-weighted average price',
        },
        medianPrice: {
          type: 'string',
          description: 'Median price across all paths',
        },
      },
    },
  })
  @Get(':address/price/analysis')
  async getTokenPriceAnalysis(
    @Param('address', AeContractAddressPipe) address: string,
    @Query('base_token', OptionalAeContractAddressPipe) baseToken?: string,
    @Query('debug') debug?: boolean,
  ) {
    const token = await this.dexTokenService.findByAddress(address);
    if (!token) {
      throw new NotFoundException(
        `DEX token with address ${address} not found`,
      );
    }

    const analysis =
      await this.dexTokenService.getTokenPriceWithLiquidityAnalysis(
        address,
        baseToken,
        debug,
      );

    if (!analysis) {
      throw new NotFoundException(`No price paths found for token ${address}`);
    }

    return analysis;
  }

  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token contract address',
  })
  @ApiOperation({
    operationId: 'getDexTokenSummary',
    summary: 'Get DEX token summary',
    description:
      'Get comprehensive summary data for a token including aggregated volume and price changes across all pools where the token appears.',
  })
  @ApiOkResponse({ type: DexTokenSummaryDto })
  @Get(':address/summary')
  async getTokenSummary(
    @Param('address', AeContractAddressPipe) address: string,
  ) {
    const token = await this.dexTokenService.findByAddress(address);
    if (!token) {
      throw new NotFoundException(
        `DEX token with address ${address} not found`,
      );
    }
    const summary =
      await this.dexTokenSummaryService.createOrUpdateSummary(address);
    return { ...summary, address };
  }

  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token contract address',
  })
  @ApiQuery({
    name: 'interval',
    type: 'number',
    required: false,
    description: `Candle interval in seconds (default 3600, min ${MIN_HISTORY_INTERVAL_SECONDS}, max ${MAX_HISTORY_INTERVAL_SECONDS})`,
  })
  @ApiQuery({
    name: 'convertTo',
    enum: ['ae', 'usd', 'eur', 'aud', 'brl', 'cad', 'chf', 'gbp', 'xau'],
    required: false,
    description:
      'Currency the OHLC/market-cap/volume values are converted into (default: ae). ' +
      'Fiat conversion uses the AE→currency rate as of each candle’s time (historical ' +
      'coin_prices snapshots) and requires the token to have a WAE-quoted pool; requesting ' +
      'a fiat currency for a token without one returns 400.',
  })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiOperation({
    operationId: 'getDexTokenHistory',
    summary: 'Get DEX token price history',
    description:
      'Get OHLCV price history for a single token. The series is derived from the deepest pool that pairs the token against WAE (so the price is expressed in AE); if no WAE pool exists, the deepest available pool is used. Pass convertTo to express the values in a fiat currency.',
  })
  @Get(':address/history')
  async getTokenHistory(
    @Param('address', AeContractAddressPipe) address: string,
    @Query('interval', new DefaultValuePipe(3600), ParseIntPipe)
    interval: number = 3600,
    @Query('convertTo') convertTo: string = 'ae',
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
  ) {
    if (
      interval < MIN_HISTORY_INTERVAL_SECONDS ||
      interval > MAX_HISTORY_INTERVAL_SECONDS
    ) {
      throw new BadRequestException(
        `interval must be between ${MIN_HISTORY_INTERVAL_SECONDS} and ${MAX_HISTORY_INTERVAL_SECONDS} seconds`,
      );
    }

    const token = await this.dexTokenService.findByAddress(address);
    if (!token) {
      throw new NotFoundException(
        `DEX token with address ${address} not found`,
      );
    }

    const best = await this.dexTokenService.findBestPairForToken(address);
    if (!best) {
      throw new NotFoundException(
        `No liquidity pool found to chart token ${address}`,
      );
    }

    return this.pairHistoryService.getPaginatedHistoricalData({
      pair: best.pair,
      interval,
      fromToken: best.basePosition,
      convertTo,
      page,
      limit,
    });
  }

  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token contract address',
  })
  @ApiSecurity('api-key')
  @ApiOperation({
    operationId: 'setDexTokenListed',
    summary: 'Set the listed flag for a DEX token (admin)',
    description:
      'Mark a token as listed/unlisted. Requires an API key (x-api-key header or Bearer token).',
  })
  @ApiOkResponse({ type: DexTokenDto })
  @UseGuards(ApiKeyGuard)
  @Patch(':address/listed')
  async setListed(
    @Param('address', AeContractAddressPipe) address: string,
    @Body() body: SetListedDto,
  ) {
    const token = await this.dexTokenService.setListed(address, body.listed);
    if (!token) {
      throw new NotFoundException(
        `DEX token with address ${address} not found`,
      );
    }
    return token;
  }
}

import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { AeContractAddressPipe } from '@/common/validation/request-validation';
import { SwapRoutePairDto } from '../dto/swap-route.dto';
import { Pair } from '../entities/pair.entity';
import { PairService } from '../services/pair.service';

/**
 * Map an internal Pair entity to the lean route shape the swap UI expects:
 * address-form tokens, reserves under `liquidityInfo`, and a `synchronized`
 * flag derived from whether the pool actually has liquidity on both sides.
 */
function toRoutePair(pair: Pair): SwapRoutePairDto {
  const reserve0 = pair.reserve0?.toString() ?? '0';
  const reserve1 = pair.reserve1?.toString() ?? '0';
  return {
    address: pair.address,
    synchronized: Number(reserve0) > 0 && Number(reserve1) > 0,
    token0: pair.token0?.address,
    token1: pair.token1?.address,
    liquidityInfo: {
      totalSupply: pair.total_supply?.toString() ?? '0',
      reserve0,
      reserve1,
    },
  };
}

/**
 * Replicates the legacy DEX backend's `/swap-routes/:from/:to` endpoint that
 * the swap UI uses to quote a trade. It returns every routing route (direct and
 * single-hop) between two tokens, reusing the proven path-finding in
 * PairService.findSwapPaths.
 *
 * The response is a bare array of routes (each route an ordered array of
 * pairs), matching the legacy contract. This is leaner than wrapping it in an
 * object: a direct route is simply a route of length 1, and the route count is
 * the array length — so no redundant `directPairs`/`totalPaths` fields are
 * sent. An empty array means no route exists (not a 404), which is a normal
 * answer for a quote.
 */
@Controller('dex/swap-routes')
@ApiTags('DEX')
export class SwapRoutesController {
  constructor(private readonly pairService: PairService) {}

  @ApiParam({
    name: 'from_token',
    type: 'string',
    description: 'Source token contract address',
  })
  @ApiParam({
    name: 'to_token',
    type: 'string',
    description: 'Destination token contract address',
  })
  @ApiOperation({
    operationId: 'getSwapRoutes',
    summary: 'Get swap routes between two tokens',
    description:
      'Returns all swap routes (direct and single-hop) from one token to ' +
      'another, used by the swap UI to quote a trade. Each route is an ordered ' +
      'array of pairs. Returns an empty array when no route exists.',
  })
  @ApiExtraModels(SwapRoutePairDto)
  @ApiOkResponse({
    description:
      'All swap routes between the tokens; each route is an ordered array of pairs',
    schema: {
      type: 'array',
      items: {
        type: 'array',
        items: { $ref: getSchemaPath(SwapRoutePairDto) },
      },
    },
  })
  @Get(':from_token/:to_token')
  async getSwapRoutes(
    @Param('from_token', AeContractAddressPipe) fromToken: string,
    @Param('to_token', AeContractAddressPipe) toToken: string,
  ): Promise<SwapRoutePairDto[][]> {
    const { paths } = await this.pairService.findSwapPaths(fromToken, toToken);
    return paths.map((route) => route.map(toRoutePair));
  }
}

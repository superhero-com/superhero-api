import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { AeContractAddressPipe } from '@/common/validation/request-validation';
import { PairService } from '../services/pair.service';

/**
 * Replicates the legacy DEX backend's `/swap-routes/:from/:to` endpoint that
 * the swap UI uses to quote a trade. It returns every routing path (direct and
 * single-hop) between two tokens, reusing the proven path-finding in
 * PairService.findSwapPaths.
 *
 * Unlike the sibling `dex/pairs/.../providers` endpoint, this does NOT 404 when
 * no route exists: "no route" is a normal answer for a quote, so callers get an
 * empty `paths` array (totalPaths: 0) to handle gracefully.
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
      'Returns all swap routes (direct pairs and multi-hop paths) from one ' +
      'token to another, used by the swap UI to quote a trade. Returns an ' +
      'empty paths array when no route exists.',
  })
  @ApiOkResponse({
    description:
      'All swap routes between the tokens, with direct pairs and path count',
    schema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: {
            type: 'array',
            items: { $ref: '#/components/schemas/PairDto' },
          },
          description:
            'All possible swap paths, where each path is an ordered array of pairs',
        },
        directPairs: {
          type: 'array',
          items: { $ref: '#/components/schemas/PairDto' },
          description: 'Direct pairs between the tokens (if any)',
        },
        hasDirectPath: {
          type: 'boolean',
          description: 'Whether there is a direct pair between the tokens',
        },
        totalPaths: {
          type: 'number',
          description: 'Total number of possible paths',
        },
      },
    },
  })
  @Get(':from_token/:to_token')
  async getSwapRoutes(
    @Param('from_token', AeContractAddressPipe) fromToken: string,
    @Param('to_token', AeContractAddressPipe) toToken: string,
  ) {
    const result = await this.pairService.findSwapPaths(fromToken, toToken);

    return {
      ...result,
      hasDirectPath: result.directPairs.length > 0,
      totalPaths: result.paths.length,
    };
  }
}

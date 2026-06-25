import { ApiProperty } from '@nestjs/swagger';

export class RouteLiquidityInfoDto {
  @ApiProperty({ description: 'Total supply of the pair LP token' })
  totalSupply: string;

  @ApiProperty({ description: 'Reserve of token0' })
  reserve0: string;

  @ApiProperty({ description: 'Reserve of token1' })
  reserve1: string;
}

/**
 * Lean pair shape used inside swap routes, matching the legacy dex-backend
 * `PairWithLiquidityAndTokenAddresses` contract the swap UI consumes:
 * token0/token1 are plain addresses (not nested objects) and reserves live
 * under `liquidityInfo`. `synchronized` tells the UI the pool has usable
 * liquidity — the swap UI filters out routes where any pair is not synchronized,
 * so this field must be present (an absent/undefined value silently drops the
 * route).
 */
export class SwapRoutePairDto {
  @ApiProperty({ description: 'Pair contract address' })
  address: string;

  @ApiProperty({
    description:
      'Whether the pair has usable (non-zero) reserves on both sides. Routes containing an unsynchronized pair are not quotable.',
    example: true,
  })
  synchronized: boolean;

  @ApiProperty({ description: 'token0 contract address' })
  token0: string;

  @ApiProperty({ description: 'token1 contract address' })
  token1: string;

  @ApiProperty({ type: () => RouteLiquidityInfoDto })
  liquidityInfo: RouteLiquidityInfoDto;
}

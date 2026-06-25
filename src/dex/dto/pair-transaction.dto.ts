import { ApiProperty } from '@nestjs/swagger';
import { PairDto } from './pair.dto';

export class SwapInfoDto {
  @ApiProperty({ description: 'Amount of token0 sent into the pair' })
  amount0In: string;

  @ApiProperty({ description: 'Amount of token1 sent into the pair' })
  amount1In: string;

  @ApiProperty({ description: 'Amount of token0 sent out of the pair' })
  amount0Out: string;

  @ApiProperty({ description: 'Amount of token1 sent out of the pair' })
  amount1Out: string;

  @ApiProperty({ description: 'Recipient account address', nullable: true })
  to: string;
}

export class LiquidityInfoDto {
  @ApiProperty({
    description: 'Liquidity operation type',
    enum: ['PairMint', 'PairBurn'],
  })
  type: string;

  @ApiProperty({ description: 'Amount of token0 added/removed' })
  amount0: string;

  @ApiProperty({ description: 'Amount of token1 added/removed' })
  amount1: string;
}

export class PairTransactionDto {
  @ApiProperty({
    description: 'Transaction hash',
    example: 'th_2AfnEfCSPx4A6VjMBfDfqHNYcqDJjuJjGV1qhqP5qNKNBvYfE2',
  })
  tx_hash: string;

  @ApiProperty({
    description: 'Account that submitted the transaction',
    example: 'ak_2AfnEfCSPx4A6VjMBfDfqHNYcqDJjuJjGV1qhqP5qNKNBvYfE2',
    nullable: true,
  })
  account_address: string;

  @ApiProperty({
    description: 'Block height at which the transaction was included',
    example: 1234567,
  })
  block_height: number;

  @ApiProperty({
    description: 'Associated pair',
    type: () => PairDto,
  })
  pair: PairDto;

  @ApiProperty({
    description:
      'Transaction type (e.g., swap, add_liquidity, remove_liquidity)',
    example: 'swap_exact_tokens_for_tokens',
  })
  tx_type: string;

  @ApiProperty({
    description: 'Reserve of token0 after the transaction',
    example: '1000000000000000000000000',
  })
  reserve0: string;

  @ApiProperty({
    description: 'Reserve of token1 after the transaction',
    example: '1000000000000000000000000',
  })
  reserve1: string;

  @ApiProperty({
    description: 'Price of token0 quoted in token1 (reserve0 / reserve1)',
    example: '0.5',
  })
  ratio0: string;

  @ApiProperty({
    description: 'Price of token1 quoted in token0 (reserve1 / reserve0)',
    example: '2',
  })
  ratio1: string;

  @ApiProperty({
    description: 'Total supply of the pair LP token after the transaction',
    example: '1000000000000000000000000',
  })
  total_supply: string;

  @ApiProperty({
    description:
      'Traded volume of token0 (sum of in/out amounts) for swaps; 0 for liquidity operations',
    example: '1000000000000000000',
  })
  volume0: string;

  @ApiProperty({
    description:
      'Traded volume of token1 (sum of in/out amounts) for swaps; 0 for liquidity operations',
    example: '1000000000000000000',
  })
  volume1: string;

  @ApiProperty({ description: 'Market cap denominated in token0' })
  market_cap0: string;

  @ApiProperty({ description: 'Market cap denominated in token1' })
  market_cap1: string;

  @ApiProperty({ description: 'Pool market cap' })
  market_cap: string;

  @ApiProperty({
    description: 'Swap event details (present for swap transactions)',
    type: () => SwapInfoDto,
    nullable: true,
  })
  swap_info: SwapInfoDto | null;

  @ApiProperty({
    description:
      'Liquidity event details (present for add/remove liquidity transactions)',
    type: () => LiquidityInfoDto,
    nullable: true,
  })
  pair_mint_info: LiquidityInfoDto | null;

  @ApiProperty({
    description: 'Transaction creation timestamp',
    example: '2024-01-01T00:00:00.000Z',
  })
  created_at: Date;
}

import { ApiProperty } from '@nestjs/swagger';
import { DexTokenDto } from './dex-token.dto';

export class PairDto {
  @ApiProperty({
    description: 'Pair contract address',
    example: 'ct_2AfnEfCSPx4A6VjMBfDfqHNYcqDJjuJjGV1qhqP5qNKNBvYfE2',
  })
  address: string;

  @ApiProperty({
    description: 'First token in the pair',
    type: () => DexTokenDto,
  })
  token0: DexTokenDto;

  @ApiProperty({
    description: 'Second token in the pair',
    type: () => DexTokenDto,
  })
  token1: DexTokenDto;

  @ApiProperty({
    description: 'Number of transactions for this pair',
    example: 150,
  })
  transactions_count: number;

  @ApiProperty({
    description: 'Pair creation timestamp',
    example: '2024-01-01T00:00:00.000Z',
  })
  created_at: Date;
}

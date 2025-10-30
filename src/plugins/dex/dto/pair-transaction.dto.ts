import { ApiProperty } from '@nestjs/swagger';
import { PairDto } from './pair.dto';

export class PairTransactionDto {
  @ApiProperty({
    description: 'Transaction hash',
    example: 'th_2AfnEfCSPx4A6VjMBfDfqHNYcqDJjuJjGV1qhqP5qNKNBvYfE2',
  })
  tx_hash: string;

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
    description: 'Transaction creation timestamp',
    example: '2024-01-01T00:00:00.000Z',
  })
  created_at: Date;
}

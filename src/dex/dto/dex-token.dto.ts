import { ApiProperty } from '@nestjs/swagger';

export class DexTokenDto {
  @ApiProperty({
    description: 'Token contract address',
    example: 'ct_2AfnEfCSPx4A6VjMBfDfqHNYcqDJjuJjGV1qhqP5qNKNBvYfE2',
  })
  address: string;

  @ApiProperty({
    description: 'Token name',
    example: 'Wrapped Aeternity',
  })
  name: string;

  @ApiProperty({
    description: 'Token symbol',
    example: 'WAE',
  })
  symbol: string;

  @ApiProperty({
    description: 'Token decimals',
    example: 18,
  })
  decimals: number;

  @ApiProperty({
    description: 'Number of pairs this token is part of',
    example: 5,
  })
  pairs_count: number;

  @ApiProperty({
    description: 'Token creation timestamp',
    example: '2024-01-01T00:00:00.000Z',
  })
  created_at: Date;

  @ApiProperty({
    description: 'Token is AE',
    example: false,
  })
  is_ae: boolean;
}

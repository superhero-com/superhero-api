import { ApiProperty } from '@nestjs/swagger';

export class BclTokenStatsDto {
  @ApiProperty({
    description: 'Token sale address',
    example: 'ct_...',
  })
  sale_address: string;

  @ApiProperty({
    description: 'Number of unique transactions in the last 24 hours',
    example: 150,
  })
  unique_transactions: number;

  @ApiProperty({
    description: 'Investment volume (buy + create_community) in AE in the last 24 hours',
    example: 5000.5,
  })
  investment_volume: number;

  @ApiProperty({
    description: 'Token lifetime in minutes (capped at 1440)',
    example: 720,
  })
  lifetime_minutes: number;

  @ApiProperty({
    description: 'Minimum unique transactions across all tokens',
    example: 0,
  })
  min_unique_transactions: number;

  @ApiProperty({
    description: 'Maximum unique transactions across all tokens',
    example: 500,
  })
  max_unique_transactions: number;

  @ApiProperty({
    description: 'Minimum investment volume across all tokens',
    example: 0,
  })
  min_investment_volume: number;

  @ApiProperty({
    description: 'Maximum investment volume across all tokens',
    example: 100000,
  })
  max_investment_volume: number;

  @ApiProperty({
    description: 'Transaction normalization result (0-1)',
    example: 0.75,
  })
  tx_normalization: number;

  @ApiProperty({
    description: 'Volume normalization result (0-1)',
    example: 0.65,
  })
  volume_normalization: number;

  @ApiProperty({
    description: 'Calculated trending score',
    example: 0.68,
  })
  trending_score: number;

  @ApiProperty({
    description: 'Timestamp when the score was calculated',
    example: '2024-01-01T00:00:00Z',
  })
  calculated_at: Date;
}


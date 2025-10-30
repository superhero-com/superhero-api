import { ApiProperty } from '@nestjs/swagger';

export class DailyTradeVolumeQueryDto {
  @ApiProperty({
    description: 'Start date for the query (YYYY-MM-DD)',
    required: false,
  })
  start_date?: string;

  @ApiProperty({
    description: 'End date for the query (YYYY-MM-DD)',
    required: false,
  })
  end_date?: string;

  @ApiProperty({
    description: 'Token address to filter by',
    required: false,
  })
  token_address?: string;

  @ApiProperty({
    description: 'Account address to filter by',
    required: false,
  })
  account_address?: string;
}

export class DailyTradeVolumeResultDto {
  @ApiProperty({
    description: 'Date of the volume data',
    example: '2024-01-01T00:00:00.000Z',
  })
  date: Date;

  @ApiProperty({
    description: 'Volume in AE tokens',
    example: 1000.5,
  })
  volume_ae: number;

  @ApiProperty({
    description: 'Number of transactions',
    example: 50,
  })
  transaction_count: number;
}

export class DailyUniqueActiveUsersQueryDto {
  @ApiProperty({
    description: 'Start date for the query (YYYY-MM-DD)',
    required: false,
  })
  start_date?: string;

  @ApiProperty({
    description: 'End date for the query (YYYY-MM-DD)',
    required: false,
  })
  end_date?: string;

  @ApiProperty({
    description: 'Token address to filter by',
    required: false,
  })
  token_address?: string;
}

export class DailyUniqueActiveUsersResultDto {
  @ApiProperty({
    description: 'Date of the active users data',
    example: '2024-01-01T00:00:00.000Z',
  })
  date: Date;

  @ApiProperty({
    description: 'Number of unique active users',
    example: 150,
  })
  active_users: number;
}

export class TotalUniqueUsersResultDto {
  @ApiProperty({
    description: 'Total number of unique users across the entire system',
    example: 5000,
  })
  total_users: number;
}

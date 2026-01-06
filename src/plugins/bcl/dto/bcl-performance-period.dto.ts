import { ApiProperty } from '@nestjs/swagger';

export enum BclChangeDirection {
  UP = 'up',
  DOWN = 'down',
  NEUTRAL = 'neutral',
}

export class BclPerformancePeriodDto {
  @ApiProperty({ description: 'Current price data', nullable: true })
  current: any;

  @ApiProperty({ description: 'Current price date', nullable: true })
  current_date: Date | null;

  @ApiProperty({ description: 'Price change amount', nullable: true })
  current_change: number | null;

  @ApiProperty({ description: 'Price change percentage', nullable: true })
  current_change_percent: number | null;

  @ApiProperty({ 
    description: 'Price change direction',
    enum: BclChangeDirection,
    nullable: true 
  })
  current_change_direction: 'up' | 'down' | 'neutral' | null;

  @ApiProperty({ description: 'Highest price data', nullable: true })
  high: any;

  @ApiProperty({ description: 'Highest price date', nullable: true })
  high_date: Date | null;

  @ApiProperty({ description: 'Lowest price data', nullable: true })
  low: any;

  @ApiProperty({ description: 'Lowest price date', nullable: true })
  low_date: Date | null;

  @ApiProperty({ description: 'Last updated timestamp', nullable: true })
  last_updated: Date | null;
}

export class BclAllTimePerformanceDto {
  @ApiProperty({ description: 'First price data', nullable: true })
  current: any;

  @ApiProperty({ description: 'First price date', nullable: true })
  current_date: Date | null;

  @ApiProperty({ description: 'Highest price data', nullable: true })
  high: any;

  @ApiProperty({ description: 'Highest price date', nullable: true })
  high_date: Date | null;

  @ApiProperty({ description: 'Lowest price data', nullable: true })
  low: any;

  @ApiProperty({ description: 'Lowest price date', nullable: true })
  low_date: Date | null;
}


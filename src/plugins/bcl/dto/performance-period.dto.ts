import { ApiProperty } from '@nestjs/swagger';
import { PriceDto } from './price.dto';

export enum ChangeDirection {
  UP = 'up',
  DOWN = 'down',
  NEUTRAL = 'neutral',
}

export class PerformancePeriodDto {
  @ApiProperty({ type: () => PriceDto })
  current: PriceDto;

  @ApiProperty()
  current_date: Date;

  @ApiProperty()
  current_change: number;

  @ApiProperty()
  current_change_percent: number;

  @ApiProperty({ enum: ChangeDirection })
  current_change_direction: string;

  @ApiProperty({ type: () => PriceDto })
  high: PriceDto;

  @ApiProperty()
  high_date: Date;

  @ApiProperty({ type: () => PriceDto })
  low: PriceDto;

  @ApiProperty()
  low_date: Date;

  @ApiProperty()
  last_updated: Date;
}

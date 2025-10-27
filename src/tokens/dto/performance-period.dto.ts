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
  current_change: number;

  @ApiProperty()
  current_change_percent: number;

  @ApiProperty({ enum: ChangeDirection })
  current_change_direction: string;

  @ApiProperty({ type: () => PriceDto })
  high: PriceDto;

  @ApiProperty()
  high_change: number;

  @ApiProperty()
  high_change_percent: number;

  @ApiProperty({ enum: ChangeDirection })
  high_change_direction: string;

  @ApiProperty({ type: () => PriceDto })
  low: PriceDto;

  @ApiProperty()
  low_change: number;

  @ApiProperty()
  low_change_percent: number;

  @ApiProperty({ enum: ChangeDirection })
  low_change_direction: string;

  @ApiProperty()
  current_token_price: string;

  @ApiProperty()
  last_updated: Date;
}


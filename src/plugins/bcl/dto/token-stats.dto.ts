import { ApiProperty } from '@nestjs/swagger';
import { PriceDto } from '@/plugins/bcl/dto/price.dto';

export class PriceMovementDto {
  @ApiProperty()
  current: PriceDto;
  @ApiProperty()
  current_date: Date;
  @ApiProperty()
  current_change: number;
  @ApiProperty()
  current_change_percent: number;
  @ApiProperty()
  current_change_direction: string;

  @ApiProperty()
  high: PriceDto;
  @ApiProperty()
  high_date: Date;
  @ApiProperty()
  high_change: number;
  @ApiProperty()
  high_change_percent: number;
  @ApiProperty()
  high_change_direction: string;

  @ApiProperty()
  low: PriceDto;
  @ApiProperty()
  low_date: Date;
  @ApiProperty()
  low_change: number;
  @ApiProperty()
  low_change_percent: number;
  @ApiProperty()
  low_change_direction: string;

  @ApiProperty()
  last_updated: Date;
}

export class TokenPriceMovementDto {
  @ApiProperty()
  past_24h: PriceMovementDto;

  @ApiProperty()
  past_7d: PriceMovementDto;

  @ApiProperty()
  past_30d: PriceMovementDto;

  @ApiProperty()
  all_time: PriceMovementDto;
}

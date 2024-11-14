import { ApiProperty } from '@nestjs/swagger';

export class PriceMovementDto {
  @ApiProperty()
  high: number;
  @ApiProperty()
  high_date: Date;

  @ApiProperty()
  low: number;
  @ApiProperty()
  low_date: Date;

  @ApiProperty()
  change: number;
  @ApiProperty()
  change_percent: number;
  @ApiProperty()
  change_direction: string;

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

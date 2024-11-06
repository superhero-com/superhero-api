import { ApiProperty } from '@nestjs/swagger';

export class PriceMovementDto {
  @ApiProperty()
  high: number;

  @ApiProperty()
  low: number;

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
}

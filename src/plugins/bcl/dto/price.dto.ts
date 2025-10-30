import { ApiProperty } from '@nestjs/swagger';

export interface IPriceDto {
  ae: number;
  usd?: number;
  eur?: number;
  aud?: number;
  brl?: number;
  cad?: number;
  chf?: number;
  gbp?: number;
  xau?: number;
}

export class PriceDto {
  @ApiProperty()
  ae: number;

  @ApiProperty()
  usd: number;

  @ApiProperty()
  eur: number;

  @ApiProperty()
  aud: number;

  @ApiProperty()
  brl: number;

  @ApiProperty()
  cad: number;

  @ApiProperty()
  chf: number;

  @ApiProperty()
  gbp: number;

  @ApiProperty()
  xau: number;
}

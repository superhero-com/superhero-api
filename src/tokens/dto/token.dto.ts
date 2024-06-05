import { ApiProperty } from '@nestjs/swagger';

export class TokenDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  network_id: string;

  @ApiProperty()
  factory_address: string;

  @ApiProperty()
  sale_address: string;

  @ApiProperty()
  owner_address: string;

  /**
   * Basic Token Info
   */
  @ApiProperty()
  address: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  symbol: string;

  @ApiProperty()
  decimals: string;

  @ApiProperty()
  rank: number;

  @ApiProperty()
  price: string;

  @ApiProperty()
  sell_price: string;

  @ApiProperty()
  market_cap: string;

  @ApiProperty()
  total_supply: string;

  @ApiProperty()
  public created_at: Date;
}

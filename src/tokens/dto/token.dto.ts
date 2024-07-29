import { ApiProperty } from '@nestjs/swagger';
import { PriceDto } from './price.dto';

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
  creator_address: string;

  @ApiProperty()
  owner_address: string;

  @ApiProperty()
  beneficiary_address: string;

  @ApiProperty()
  bonding_curve_address: string;

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
  holders_count: number;

  @ApiProperty()
  price: string;

  @ApiProperty()
  price_data: PriceDto;

  @ApiProperty()
  sell_price: string;
  @ApiProperty()
  sell_price_data: PriceDto;

  @ApiProperty()
  market_cap: string;
  @ApiProperty()
  market_cap_data: PriceDto;

  @ApiProperty()
  total_supply: string;

  @ApiProperty()
  dao_balance: string;

  @ApiProperty()
  public created_at: Date;
}

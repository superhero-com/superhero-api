import { ApiProperty } from '@nestjs/swagger';
import { PriceDto } from '@/tokens/dto/price.dto';

export class BclTokenDto {
  @ApiProperty({ description: 'Token sale address' })
  sale_address: string;

  @ApiProperty({ description: 'Whether the token is unlisted' })
  unlisted: boolean;

  @ApiProperty({ description: 'Last sync transaction count' })
  last_sync_tx_count: number;

  @ApiProperty({ description: 'Total transaction count' })
  tx_count: number;

  @ApiProperty({ description: 'Number of token holders' })
  holders_count: number;

  @ApiProperty({ description: 'Factory contract address' })
  factory_address: string;

  @ApiProperty({ description: 'Create community transaction hash' })
  create_tx_hash: string;

  @ApiProperty({ description: 'DAO contract address' })
  dao_address: string;

  @ApiProperty({ description: 'Creator account address' })
  creator_address: string;

  @ApiProperty({ description: 'Beneficiary account address' })
  beneficiary_address: string;

  @ApiProperty({ description: 'Bonding curve contract address' })
  bonding_curve_address: string;

  @ApiProperty({ description: 'DAO balance' })
  dao_balance: string;

  @ApiProperty({ description: 'Owner account address' })
  owner_address: string;

  @ApiProperty({ description: 'Token contract address (AEX9)' })
  address: string;

  @ApiProperty({ description: 'Token name' })
  name: string;

  @ApiProperty({ description: 'Token symbol' })
  symbol: string;

  @ApiProperty({ description: 'Token decimals' })
  decimals: string;

  @ApiProperty({ description: 'Collection identifier', nullable: true })
  collection: string | null;

  @ApiProperty({ description: 'Current buy price' })
  price: string;

  @ApiProperty({ description: 'Price data with multiple currencies', type: PriceDto })
  price_data: PriceDto;

  @ApiProperty({ description: 'Current sell price' })
  sell_price: string;

  @ApiProperty({ description: 'Sell price data with multiple currencies', type: PriceDto })
  sell_price_data: PriceDto;

  @ApiProperty({ description: 'Market capitalization' })
  market_cap: string;

  @ApiProperty({ description: 'Market cap data with multiple currencies', type: PriceDto })
  market_cap_data: PriceDto;

  @ApiProperty({ description: 'Total supply' })
  total_supply: string;

  @ApiProperty({ description: 'Trending score' })
  trending_score: string;

  @ApiProperty({ description: 'Trending score last update timestamp', nullable: true })
  trending_score_update_at: Date | null;

  @ApiProperty({ description: 'Token creation timestamp' })
  created_at: Date;

  @ApiProperty({ description: 'Last transaction hash' })
  last_tx_hash: string;

  @ApiProperty({ description: 'Last sync block height' })
  last_sync_block_height: number;

  @ApiProperty({ description: 'Token rank based on market cap' })
  rank: number;
}


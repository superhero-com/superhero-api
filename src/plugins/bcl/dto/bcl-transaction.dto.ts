import { ApiProperty } from '@nestjs/swagger';
import { PriceDto } from '@/tokens/dto/price.dto';

export class BclTransactionDto {
  @ApiProperty({ description: 'Transaction hash' })
  tx_hash: string;

  @ApiProperty({ description: 'Sale address (token sale contract address)' })
  sale_address: string;

  @ApiProperty({ description: 'Transaction type (buy or sell)' })
  tx_type: string;

  @ApiProperty({ description: 'Block height' })
  block_height: number;

  @ApiProperty({ description: 'Whether the transaction is verified (at least 5 hours old)' })
  verified: boolean;

  @ApiProperty({ description: 'Address of the user who made this transaction' })
  address: string;

  @ApiProperty({ description: 'Volume (total units bought/sold)' })
  volume: string;

  @ApiProperty({ description: 'Protocol reward' })
  protocol_reward: string;

  @ApiProperty({ description: 'Amount spent/received', type: PriceDto })
  amount: PriceDto;

  @ApiProperty({ description: 'Unit price', type: PriceDto })
  unit_price: PriceDto;

  @ApiProperty({ description: 'Previous buy price before this transaction', type: PriceDto, nullable: true })
  previous_buy_price?: PriceDto;

  @ApiProperty({ description: 'Buy price after this transaction', type: PriceDto })
  buy_price: PriceDto;

  @ApiProperty({ description: 'Sell price (null for buy transactions)', type: PriceDto, nullable: true })
  sell_price?: PriceDto;

  @ApiProperty({ description: 'Total supply of the token at the time of this transaction' })
  total_supply: string;

  @ApiProperty({ description: 'Market cap at the time of this transaction', type: PriceDto, nullable: true })
  market_cap?: PriceDto;

  @ApiProperty({ description: 'Created at timestamp' })
  created_at: Date;
}


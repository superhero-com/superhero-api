import { ApiProperty } from '@nestjs/swagger';
import { PriceDto } from '@/plugins/bcl/dto/price.dto';

export class TransactionDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  account: string;

  @ApiProperty()
  tx_hash: string;

  @ApiProperty()
  tx_type: string;

  @ApiProperty()
  spent_amount: string;

  @ApiProperty()
  spent_amount_data: PriceDto;

  @ApiProperty()
  volume: string;

  @ApiProperty()
  price: string;

  @ApiProperty()
  price_data: PriceDto;

  @ApiProperty()
  sell_price: string;

  @ApiProperty()
  sell_price_data: PriceDto;

  @ApiProperty()
  public created_at: Date;
}

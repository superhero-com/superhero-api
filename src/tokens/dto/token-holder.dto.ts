import { ApiProperty } from '@nestjs/swagger';
import { PriceDto } from './price.dto';

export class TokenHolderDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  address: string;

  @ApiProperty()
  balance: string;

  @ApiProperty()
  balance_data: PriceDto;

  @ApiProperty()
  percentage: number;

  @ApiProperty()
  public created_at: Date;
}

import { ApiProperty } from '@nestjs/swagger';
import { IPriceDto } from './price.dto';

export class MarketCapSumDto {
  @ApiProperty()
  sum: string;

  @ApiProperty()
  sum_data: IPriceDto;
}

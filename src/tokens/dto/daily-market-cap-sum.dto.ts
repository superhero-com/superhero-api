import { ApiProperty } from '@nestjs/swagger';
import { IPriceDto } from './price.dto';

export class DailyMarketCapSumDto {
  @ApiProperty()
  date: string;

  @ApiProperty()
  sum: string;

  @ApiProperty()
  sum_data: IPriceDto;
} 

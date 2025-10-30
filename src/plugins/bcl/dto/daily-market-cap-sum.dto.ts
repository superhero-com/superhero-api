import { ApiProperty } from '@nestjs/swagger';

export class DailyMarketCapSumDto {
  @ApiProperty()
  date: string;

  @ApiProperty()
  sum: string;
}

import { ApiProperty } from '@nestjs/swagger';

export class TokenPerformanceDto {
  @ApiProperty()
  sale_address: string;

  @ApiProperty({ type: Object, nullable: true })
  past_24h: any;

  @ApiProperty({ type: Object, nullable: true })
  past_7d: any;

  @ApiProperty({ type: Object, nullable: true })
  past_30d: any;

  @ApiProperty({ type: Object, nullable: true })
  all_time: any;

  @ApiProperty()
  created_at: Date;

  @ApiProperty()
  updated_at: Date;
}


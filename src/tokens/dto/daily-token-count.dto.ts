import { ApiProperty } from '@nestjs/swagger';

export class DailyTokenCountDto {
  @ApiProperty({
    description: 'The date in YYYY-MM-DD format',
    example: '2024-03-01',
  })
  date: string;

  @ApiProperty({
    description: 'Number of tokens created on this date',
    example: 5,
  })
  count: number;
}

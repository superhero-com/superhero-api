import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class TradingStatsQueryDto {
  @ApiProperty({
    name: 'startDate',
    type: 'string',
    required: false,
    description: 'Start date (ISO 8601, inclusive). Defaults to 30 days ago.',
    example: '2026-01-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsString()
  startDate?: string;

  @ApiProperty({
    name: 'endDate',
    type: 'string',
    required: false,
    description: 'End date (ISO 8601, exclusive). Defaults to now.',
    example: '2026-01-31T23:59:59.999Z',
  })
  @IsOptional()
  @IsString()
  endDate?: string;
}

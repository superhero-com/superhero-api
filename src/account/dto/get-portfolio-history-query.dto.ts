import { ApiProperty } from '@nestjs/swagger';
import {
  IsOptional,
  IsInt,
  IsString,
  IsIn,
  IsDateString,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class GetPortfolioHistoryQueryDto {
  @ApiProperty({
    name: 'startDate',
    type: 'string',
    required: false,
    description: 'Start date (ISO 8601)',
    example: '2024-01-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiProperty({
    name: 'endDate',
    type: 'string',
    required: false,
    description: 'End date (ISO 8601)',
    example: '2024-12-31T23:59:59.999Z',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiProperty({
    name: 'interval',
    type: 'number',
    required: false,
    description: 'Interval in seconds (default: 86400 for daily)',
    example: 86400,
    default: 86400,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  interval?: number;

  @ApiProperty({
    name: 'convertTo',
    enum: ['ae', 'usd', 'eur', 'aud', 'brl', 'cad', 'chf', 'gbp', 'xau'],
    required: false,
    description: 'Currency to convert to (default: ae)',
    example: 'ae',
  })
  @IsOptional()
  @IsIn(['ae', 'usd', 'eur', 'aud', 'brl', 'cad', 'chf', 'gbp', 'xau'])
  convertTo?:
    | 'ae'
    | 'usd'
    | 'eur'
    | 'aud'
    | 'brl'
    | 'cad'
    | 'chf'
    | 'gbp'
    | 'xau';

  @ApiProperty({
    name: 'include',
    type: 'string',
    required: false,
    description: 'Comma-separated list of fields to include (e.g., "pnl")',
    example: 'pnl',
  })
  @IsOptional()
  @IsString()
  include?: string;
}


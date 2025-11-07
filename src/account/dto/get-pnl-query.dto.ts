import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

export class GetPnlQueryDto {
  @ApiProperty({
    name: 'blockHeight',
    type: 'number',
    required: false,
    description: 'Block height (default: current block height)',
    example: 12345678,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  blockHeight?: number;
}


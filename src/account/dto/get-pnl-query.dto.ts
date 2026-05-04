import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';
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
  @IsInt()
  @Min(0)
  @Type(() => Number)
  blockHeight?: number;
}

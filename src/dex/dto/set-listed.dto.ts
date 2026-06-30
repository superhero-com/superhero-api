import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetListedDto {
  @ApiProperty({
    description: 'Whether the token should be marked as listed',
    example: true,
  })
  @IsBoolean()
  listed: boolean;
}

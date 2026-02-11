import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class VerifyXDto {
  @ApiProperty({
    description: 'OAuth credential from X login flow',
    example: 'oauth_access_token_or_code',
  })
  @IsString()
  @Length(1, 2048)
  access_code: string;
}

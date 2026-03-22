import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsString, Matches } from 'class-validator';

export class CreateAffiliationDto {
  @ApiProperty({ example: 'ak_2F4ExampleAddress' })
  @IsString()
  @Matches(/^ak_[1-9A-HJ-NP-Za-km-z]+$/)
  sender_address: string;

  @ApiProperty({ example: ['code1', 'code2', 'code3'] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  codes: string[];
}

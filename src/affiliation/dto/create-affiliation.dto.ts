import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsAeAccountAddress } from '@/common/validation/request-validation';

export class CreateAffiliationDto {
  @ApiProperty({ example: 'ak_2F4ExampleAddress' })
  @IsString()
  @IsAeAccountAddress()
  sender_address: string;

  @ApiProperty({ example: ['code1', 'code2', 'code3'] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  codes: string[];
}

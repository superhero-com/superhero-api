import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';
import { IsAeAccountAddress } from '@/common/validation/request-validation';

export class CreateAffiliationDto {
  @ApiProperty({ example: 'ak_2F4ExampleAddress' })
  @IsString()
  @IsAeAccountAddress()
  sender_address: string;

  @ApiProperty({ example: ['code1', 'code2', 'code3'] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  codes: string[];
}

import { ApiProperty } from '@nestjs/swagger';
import { IsString, Validate } from 'class-validator';
import { AeAccountAddressConstraint } from './ae-account-address.validator';

export class CreateChainNameChallengeDto {
  @ApiProperty({
    description: 'Account address (ak_...) that will own the claimed name',
    example: 'ak_2519mBsgjJEVEFoRgno1ryDsn3BEaCZGRbXPEjThWYLX9MTpmk',
  })
  @IsString()
  @Validate(AeAccountAddressConstraint)
  address: string;
}

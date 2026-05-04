import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { IsAeAccountAddress } from '@/common/validation/request-validation';

export class CreateChainNameChallengeDto {
  @ApiProperty({
    description: 'Account address (ak_...) that will own the claimed name',
    example: 'ak_2519mBsgjJEVEFoRgno1ryDsn3BEaCZGRbXPEjThWYLX9MTpmk',
  })
  @IsString()
  @IsAeAccountAddress()
  address: string;
}

import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { IsAeAccountAddress } from '@/common/validation/request-validation';

export class ClaimPreferredLinkDto {
  @IsString()
  @IsNotEmpty()
  @IsAeAccountAddress()
  address: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  value: string;
}

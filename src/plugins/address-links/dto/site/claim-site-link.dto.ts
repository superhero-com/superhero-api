import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { IsAeAccountAddress } from '@/common/validation/request-validation';

export class ClaimSiteLinkDto {
  @IsString()
  @IsNotEmpty()
  @IsAeAccountAddress()
  address: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  value: string;
}

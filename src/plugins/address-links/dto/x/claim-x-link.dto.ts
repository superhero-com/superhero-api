import { IsString, IsNotEmpty } from 'class-validator';
import { IsAeAccountAddress } from '@/common/validation/request-validation';

export class ClaimXLinkDto {
  @IsString()
  @IsNotEmpty()
  @IsAeAccountAddress()
  address: string;

  @IsString()
  @IsNotEmpty()
  x_code: string;

  @IsString()
  @IsNotEmpty()
  x_code_verifier: string;

  @IsString()
  @IsNotEmpty()
  x_redirect_uri: string;
}

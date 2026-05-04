import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { IsAeAccountAddress } from '@/common/validation/request-validation';

export class ClaimXLinkDto {
  @IsString()
  @IsNotEmpty()
  @IsAeAccountAddress()
  address: string;

  @IsOptional()
  @IsString()
  x_access_token?: string;

  @IsOptional()
  @IsString()
  x_code?: string;

  @IsOptional()
  @IsString()
  x_code_verifier?: string;

  @IsOptional()
  @IsString()
  x_redirect_uri?: string;
}

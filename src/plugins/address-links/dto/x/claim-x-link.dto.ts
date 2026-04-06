import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class ClaimXLinkDto {
  @IsString()
  @IsNotEmpty()
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

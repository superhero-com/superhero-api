import {
  IsString,
  IsNotEmpty,
  IsOptional,
  Matches,
  MaxLength,
} from 'class-validator';

export class ClaimLinkDto {
  @IsString()
  @IsNotEmpty()
  address: string;

  @IsString()
  @Matches(/^[a-z]+$/)
  @MaxLength(10)
  provider: string;

  /** Required for nostr (npub). For X, determined from OAuth. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  value?: string;

  // --- X-specific fields ---

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

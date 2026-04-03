import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  Matches,
  MaxLength,
} from 'class-validator';

export class SubmitLinkDto {
  @IsString()
  @IsNotEmpty()
  address: string;

  @IsString()
  @Matches(/^[a-z]+$/)
  @MaxLength(10)
  provider: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  value: string;

  @IsNumber()
  nonce: number;

  /** Hex-encoded AE wallet signature. */
  @IsString()
  @IsNotEmpty()
  signature: string;

  /** Server-signed verification token (required for X, issued at claim time). */
  @IsOptional()
  @IsString()
  verification_token?: string;

  /** JSON-encoded signed Nostr event (required for nostr). */
  @IsOptional()
  @IsString()
  nostr_event?: string;
}

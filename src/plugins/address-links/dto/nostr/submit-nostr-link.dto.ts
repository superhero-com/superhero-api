import { IsString, IsNotEmpty, IsNumber, MaxLength } from 'class-validator';
import { IsAeAccountAddress } from '@/common/validation/request-validation';

export class SubmitNostrLinkDto {
  @IsString()
  @IsNotEmpty()
  @IsAeAccountAddress()
  address: string;

  /** Nostr npub (bech32-encoded public key). */
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

  /** JSON-encoded signed Nostr event (kind 22242). */
  @IsString()
  @IsNotEmpty()
  nostr_event: string;
}

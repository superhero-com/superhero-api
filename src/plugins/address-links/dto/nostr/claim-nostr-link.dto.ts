import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class ClaimNostrLinkDto {
  @IsString()
  @IsNotEmpty()
  address: string;

  /** Nostr npub (bech32-encoded public key). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  value: string;
}

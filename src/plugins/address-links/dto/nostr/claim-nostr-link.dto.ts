import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { IsAeAccountAddress } from '@/common/validation/request-validation';

export class ClaimNostrLinkDto {
  @IsString()
  @IsNotEmpty()
  @IsAeAccountAddress()
  address: string;

  /** Nostr npub (bech32-encoded public key). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  value: string;
}

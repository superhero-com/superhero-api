import { IsString, Matches } from 'class-validator';

export class BindXInviteDto {
  @IsString()
  @Matches(/^ak_[1-9A-HJ-NP-Za-km-z]+$/)
  invitee_address: string;

  @IsString()
  @Matches(/^[a-f0-9]{24,128}$/i)
  challenge_nonce: string;

  @IsString()
  @Matches(/^\d+$/)
  challenge_expires_at: string;

  @IsString()
  @Matches(/^[a-f0-9]{128}$/i)
  signature_hex: string;
}

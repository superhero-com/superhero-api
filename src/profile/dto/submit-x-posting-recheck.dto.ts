import { IsNumberString, IsString, Matches } from 'class-validator';

export class SubmitXPostingRecheckDto {
  @IsString()
  @Matches(/^[0-9a-f]+$/i)
  challenge_nonce: string;

  @IsNumberString()
  challenge_expires_at: string;

  @IsString()
  @Matches(/^(sg_[1-9A-HJ-NP-Za-km-z]+|[0-9a-f]+)$/i)
  signature_hex: string;
}

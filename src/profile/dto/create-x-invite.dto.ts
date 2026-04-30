import { IsString, Matches } from 'class-validator';
import { IsAeAccountAddress } from '@/common/validation/request-validation';

export class CreateXInviteDto {
  @IsString()
  @IsAeAccountAddress()
  inviter_address: string;

  @IsString()
  @Matches(/^[a-f0-9]{24,128}$/i)
  challenge_nonce: string;

  @IsString()
  @Matches(/^\d+$/)
  challenge_expires_at: string;

  @IsString()
  @Matches(/^(sg_[1-9A-HJ-NP-Za-km-z]+|[a-f0-9]{128})$/i)
  signature_hex: string;
}

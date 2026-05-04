import { IsString } from 'class-validator';
import { IsAeAccountAddress } from '@/common/validation/request-validation';

export class CreateXPostingRecheckChallengeDto {
  @IsString()
  @IsAeAccountAddress()
  address: string;
}

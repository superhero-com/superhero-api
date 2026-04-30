import { IsIn, IsString, Matches, ValidateIf } from 'class-validator';
import { IsAeAccountAddress } from '@/common/validation/request-validation';

export class CreateXInviteChallengeDto {
  @IsString()
  @IsAeAccountAddress()
  address: string;

  @IsString()
  @IsIn(['create', 'bind'])
  purpose: 'create' | 'bind';

  @ValidateIf((o) => o.purpose === 'bind')
  @IsString()
  @Matches(/^[a-z0-9]{12}$/)
  code?: string;
}

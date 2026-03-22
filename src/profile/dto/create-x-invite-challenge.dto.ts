import { IsIn, IsString, Matches, ValidateIf } from 'class-validator';

export class CreateXInviteChallengeDto {
  @IsString()
  @Matches(/^ak_[1-9A-HJ-NP-Za-km-z]+$/)
  address: string;

  @IsString()
  @IsIn(['create', 'bind'])
  purpose: 'create' | 'bind';

  @ValidateIf((o) => o.purpose === 'bind')
  @IsString()
  @Matches(/^[a-z0-9]{12}$/)
  code?: string;
}

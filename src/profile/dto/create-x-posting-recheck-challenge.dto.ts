import { IsString, Matches } from 'class-validator';

export class CreateXPostingRecheckChallengeDto {
  @IsString()
  @Matches(/^ak_[1-9A-HJ-NP-Za-km-z]+$/)
  address: string;
}

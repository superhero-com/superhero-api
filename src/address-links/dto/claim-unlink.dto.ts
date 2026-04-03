import { IsString, IsNotEmpty, Matches, MaxLength } from 'class-validator';

export class ClaimUnlinkDto {
  @IsString()
  @IsNotEmpty()
  address: string;

  @IsString()
  @Matches(/^[a-z]+$/)
  @MaxLength(10)
  provider: string;
}

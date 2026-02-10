import { ApiProperty } from '@nestjs/swagger';
import { IsHexadecimal, IsString } from 'class-validator';
import { UpdateProfileDto } from './update-profile.dto';

export class ConsumeProfileChallengeDto extends UpdateProfileDto {
  @ApiProperty({ description: 'Challenge issued by /challenge endpoint' })
  @IsString()
  challenge: string;

  @ApiProperty({ description: 'Hex-encoded signature of challenge message' })
  @IsHexadecimal()
  signature: string;
}

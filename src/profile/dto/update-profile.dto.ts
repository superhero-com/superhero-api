import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUrl, Length, Matches } from 'class-validator';

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{1,32}$/;

/** Normalize null to undefined so @IsOptional() treats it as omitted; trim strings for validation */
const trimString = ({ value }: { value: unknown }) =>
  value === null ? undefined : typeof value === 'string' ? value.trim() : value;

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Nikita Novikov', maxLength: 100 })
  @IsOptional()
  @IsString()
  @Transform(trimString)
  @Length(1, 100)
  fullname?: string;

  @ApiPropertyOptional({
    example: 'Backend engineer and builder.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @Transform(trimString)
  @Length(1, 1000)
  bio?: string;

  @ApiPropertyOptional({ example: 'npub1...' })
  @IsOptional()
  @IsString()
  @Transform(trimString)
  @Length(1, 255)
  nostrkey?: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/avatar.png' })
  @IsOptional()
  @IsUrl()
  @Transform(trimString)
  @Length(1, 500)
  avatarurl?: string;

  @ApiPropertyOptional({
    example: 'nikit_dev',
    description:
      'Changing this value resets x verification state until re-verified',
  })
  @IsOptional()
  @IsString()
  @Transform(trimString)
  @Matches(USERNAME_PATTERN, {
    message: 'username must contain only letters, numbers, and underscores',
  })
  username?: string;

  @ApiPropertyOptional({ example: 'nikit_dev' })
  @IsOptional()
  @IsString()
  @Transform(trimString)
  @Matches(USERNAME_PATTERN, {
    message: 'x_username must contain only letters, numbers, and underscores',
  })
  x_username?: string;

  @ApiPropertyOptional({ example: 'nikit.chain' })
  @IsOptional()
  @IsString()
  @Transform(trimString)
  @Length(1, 255)
  chain_name?: string;

  @ApiPropertyOptional({ example: 'nikit.sol' })
  @IsOptional()
  @IsString()
  @Transform(trimString)
  @Length(1, 255)
  sol_name?: string;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, Length, Matches } from 'class-validator';

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{1,32}$/;

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Nikita Novikov', maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  fullname?: string;

  @ApiPropertyOptional({
    example: 'Backend engineer and builder.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  bio?: string;

  @ApiPropertyOptional({ example: 'npub1...' })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  nostrkey?: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/avatar.png' })
  @IsOptional()
  @IsUrl()
  @Length(1, 500)
  avatarurl?: string;

  @ApiPropertyOptional({ example: 'nikit_dev' })
  @IsOptional()
  @IsString()
  @Matches(USERNAME_PATTERN, {
    message: 'username must contain only letters, numbers, and underscores',
  })
  username?: string;

  @ApiPropertyOptional({ example: 'nikit_dev' })
  @IsOptional()
  @IsString()
  @Matches(USERNAME_PATTERN, {
    message: 'x_username must contain only letters, numbers, and underscores',
  })
  x_username?: string;

  @ApiPropertyOptional({ example: 'nikit.chain' })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  chain_name?: string;

  @ApiPropertyOptional({ example: 'nikit.sol' })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  sol_name?: string;
}

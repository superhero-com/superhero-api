import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** The `profile` sub-object of `GET /api/accounts/:address`. */
export class AccountProfileDto {
  @ApiProperty({ nullable: true })
  fullname: string | null;

  @ApiProperty({ nullable: true })
  bio: string | null;

  @ApiProperty({ nullable: true })
  site: string | null;

  @ApiProperty({ nullable: true })
  avatarurl: string | null;

  @ApiProperty({ nullable: true })
  username: string | null;

  @ApiProperty({ nullable: true })
  prefered_aens_name: string | null;

  @ApiProperty({ nullable: true })
  x_username: string | null;

  @ApiProperty({ nullable: true })
  chain_name: string | null;

  @ApiProperty({ type: String, nullable: true })
  chain_expires_at: string | null;

  // Present only when the social graph is configured; omitted (not 0/null) when
  // the feature is disabled, so a disabled deployment never asserts a count.
  @ApiPropertyOptional({
    description: 'Followers, chain-truth served from the index.',
  })
  followers_count?: number;

  @ApiPropertyOptional({
    description: 'Following, chain-truth served from the index.',
  })
  following_count?: number;
}

/**
 * Response of `GET /api/accounts/:address`, typed to the profile seam this row
 * delivers (the `profile` sub-object with follower/following counts). The full
 * account aggregate — balances, holdings, chain fields — is intentionally left
 * untyped here; typing it end-to-end is its own row.
 */
export class GetAccountResponseDto {
  @ApiProperty()
  address: string;

  @ApiProperty({ type: AccountProfileDto })
  profile: AccountProfileDto;

  @ApiProperty({ nullable: true })
  public_name: string | null;
}

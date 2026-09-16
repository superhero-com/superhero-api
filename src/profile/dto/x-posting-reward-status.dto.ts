import { ApiProperty } from '@nestjs/swagger';

/**
 * Public payload of `GET /api/profile/:address/x-posting-reward` and the body
 * of the on-demand recheck, published in OpenAPI. Every field here is part of
 * the contract; changes must stay additive.
 *
 * `program_status` / `error_code` are the machine-readable readiness signals a
 * consumer should branch on; `error` remains a human sentence a client may
 * render verbatim.
 */
export class XPostingRewardStatusDto {
  @ApiProperty({
    enum: ['not_started', 'pending', 'paid', 'failed'],
    description: 'Overall reward state for the address.',
  })
  status: 'not_started' | 'pending' | 'paid' | 'failed';

  @ApiProperty({
    enum: ['active', 'disabled', 'unavailable'],
    description:
      'Program readiness. `disabled` = intentionally off; `unavailable` = armed but a dependency (X credentials, payout key, amount) is missing.',
  })
  program_status: 'active' | 'disabled' | 'unavailable';

  @ApiProperty({
    nullable: true,
    description:
      'Stable machine-readable code for the current blocker, or null. Coarse by design; the specific missing dependency is not exposed publicly.',
    example: 'below_min_followers',
  })
  error_code: string | null;

  @ApiProperty({
    description: 'Whether the one-time onboarding reward path is enabled.',
  })
  onboarding_enabled: boolean;

  @ApiProperty({
    nullable: true,
    description:
      'Configured onboarding reward amount in AE. Null unless the program is `active`.',
    example: '0.05',
  })
  onboarding_amount_ae: string | null;

  @ApiProperty({
    type: [String],
    description: 'Keywords a qualifying onboarding post must contain.',
  })
  onboarding_keywords: string[];

  @ApiProperty({ nullable: true })
  x_username: string | null;

  @ApiProperty({ nullable: true })
  x_user_id: string | null;

  @ApiProperty({ nullable: true })
  referral_code: string | null;

  @ApiProperty({ nullable: true })
  referral_link: string | null;

  @ApiProperty({ enum: ['not_started', 'pending', 'paid', 'failed'] })
  onboarding_status: 'not_started' | 'pending' | 'paid' | 'failed';

  @ApiProperty()
  onboarding_threshold: number;

  @ApiProperty()
  qualified_posts_count: number;

  @ApiProperty()
  remaining_to_goal: number;

  @ApiProperty()
  per_post_total_paid_count: number;

  @ApiProperty({ description: 'Total per-post reward paid, in aettos.' })
  per_post_total_paid_aettos: string;

  @ApiProperty({ nullable: true })
  follower_count: number | null;

  @ApiProperty()
  min_followers_required: number;

  @ApiProperty({ nullable: true })
  follower_tier_index: number | null;

  @ApiProperty({ nullable: true })
  tier_amount_ae: string | null;

  @ApiProperty()
  current_streak_days: number;

  @ApiProperty()
  streak_required: number;

  @ApiProperty({ enum: ['not_started', 'pending', 'paid', 'failed'] })
  streak_bonus_status: 'not_started' | 'pending' | 'paid' | 'failed';

  @ApiProperty()
  streak_bonus_paid_count: number;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  next_check_allowed_at: Date | null;

  @ApiProperty({ nullable: true })
  tx_hash: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'Human-readable status sentence, rendered verbatim by clients.',
  })
  error: string | null;
}

/**
 * 503 body of the recheck route when the program is not `active` (disabled, or
 * armed but a dependency is missing). Consumers branch on `error_code`
 * (`rewards_disabled` / `rewards_unavailable`).
 */
export class XPostingRewardUnavailableDto {
  @ApiProperty({ example: 503 })
  status: number;

  @ApiProperty({ description: 'Human-readable sentence.' })
  message: string;

  @ApiProperty({
    nullable: true,
    enum: ['rewards_disabled', 'rewards_unavailable'],
  })
  error_code: string | null;
}

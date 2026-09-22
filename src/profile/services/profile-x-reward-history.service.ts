import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProfileXInviteMilestoneReward } from '../entities/profile-x-invite-milestone-reward.entity';
import { ProfileXPostingReward } from '../entities/profile-x-posting-reward.entity';
import { ProfileXPostRewardLedger } from '../entities/profile-x-post-reward-ledger.entity';
import { ProfileXStreakBonusReward } from '../entities/profile-x-streak-bonus-reward.entity';
import {
  PROFILE_X_INVITE_MILESTONE_REWARD_AMOUNT_AE,
  PROFILE_X_ONBOARDING_REWARD_AMOUNT_AE,
} from '../profile.constants';
import {
  aettosToAe,
  explorerTxUrl,
  isRealTxHash,
  payoutStatus,
} from '../utils/reward-payout.util';

export type XRewardHistoryKind =
  'onboarding' | 'per_post' | 'streak_bonus' | 'invite_milestone';

export type XRewardHistoryItem = {
  kind: XRewardHistoryKind;
  status: 'paid' | 'pending' | 'failed';
  amount_ae: string | null;
  /**
   * False when the table records no amount (onboarding, invite milestones) and
   * `amount_ae` is the currently configured value instead of what was sent.
   * The explorer link is the authority on what actually moved.
   */
  amount_recorded: boolean;
  tx_hash: string | null;
  explorer_url: string | null;
  occurred_at: string | null;
  /** per_post: the UTC day of the post that earned it. */
  post_day: string | null;
  /** streak_bonus: how many consecutive days it rewards. */
  streak_days: number | null;
  /** invite_milestone: how many invites it rewards. */
  invite_count: number | null;
};

export type XRewardHistory = {
  items: XRewardHistoryItem[];
  /** More rows exist than were returned. */
  truncated: boolean;
};

/** Per table, and for the merged list. Years of daily posting fits. */
const HISTORY_LIMIT = 100;

/**
 * Every X reward payout for one wallet, newest first, for the owner to see
 * what they got and follow each one to the block explorer.
 *
 * Payouts are sent automatically, so this list is the only place a user can
 * check that they happened. It reads the same four tables as the operator
 * explorer and answers "paid or not" with the same helpers, so the two can
 * never disagree about a payout.
 *
 * Public by design, like the status route beside it: every entry is already
 * public on-chain. It returns no tweet ids, X handles or error codes, which
 * are not.
 */
@Injectable()
export class ProfileXRewardHistoryService {
  constructor(
    @InjectRepository(ProfileXPostingReward)
    private readonly postingRewardRepository: Repository<ProfileXPostingReward>,
    @InjectRepository(ProfileXPostRewardLedger)
    private readonly postRewardLedgerRepository: Repository<ProfileXPostRewardLedger>,
    @InjectRepository(ProfileXStreakBonusReward)
    private readonly streakBonusRewardRepository: Repository<ProfileXStreakBonusReward>,
    @InjectRepository(ProfileXInviteMilestoneReward)
    private readonly inviteMilestoneRewardRepository: Repository<ProfileXInviteMilestoneReward>,
  ) {}

  async getHistory(address: string): Promise<XRewardHistory> {
    // One more than the limit, so a full page can say whether there is more.
    const take = HISTORY_LIMIT + 1;
    const [onboarding, perPost, streaks, milestones] = await Promise.all([
      this.postingRewardRepository.findOne({ where: { address } }),
      this.postRewardLedgerRepository.find({
        where: { address },
        order: { created_at: 'DESC', id: 'DESC' },
        take,
      }),
      this.streakBonusRewardRepository.find({
        where: { address },
        order: { created_at: 'DESC', id: 'DESC' },
        take,
      }),
      this.inviteMilestoneRewardRepository.find({
        where: { inviter_address: address },
        order: { created_at: 'DESC', id: 'DESC' },
        take,
      }),
    ]);

    const items: XRewardHistoryItem[] = [];
    const push = (
      item: Omit<XRewardHistoryItem, 'status' | 'tx_hash' | 'explorer_url'>,
      row: { status?: string | null; tx_hash?: string | null },
    ) => {
      const status = payoutStatus(row);
      // Skipped is terminal and nothing was sent: it is not a reward the user
      // got or is still getting, so it has no place in their history.
      if (status === 'skipped') return;
      items.push({
        ...item,
        status,
        tx_hash: isRealTxHash(row.tx_hash) ? row.tx_hash : null,
        explorer_url: explorerTxUrl(row.tx_hash),
      });
    };

    // The onboarding payout lives on the reward row itself, not in the ledger.
    // `status` 'failed' is written there only by a failed onboarding send, and
    // 'pending' is also the state of a wallet that never qualified, so only a
    // row that was actually sent (or tried) counts.
    if (
      onboarding &&
      (onboarding.status === 'paid' ||
        onboarding.status === 'failed' ||
        !!onboarding.tx_hash)
    ) {
      push(
        {
          kind: 'onboarding',
          amount_ae: PROFILE_X_ONBOARDING_REWARD_AMOUNT_AE || null,
          amount_recorded: false,
          // The row has no paid-at column. `verified_at` is when X was linked,
          // and the payout follows on the first check after a qualifying post,
          // so it is the closest durable time. `updated_at` and
          // `last_attempt_at` move on every scan and would drift forward.
          occurred_at:
            iso(onboarding.verified_at) ?? iso(onboarding.created_at),
          post_day: null,
          streak_days: null,
          invite_count: null,
        },
        onboarding,
      );
    }

    for (const row of perPost) {
      push(
        {
          kind: 'per_post',
          amount_ae: aettosToAe(row.amount_aettos),
          amount_recorded: true,
          occurred_at: iso(row.created_at),
          post_day: row.tweet_utc_day ?? null,
          streak_days: null,
          invite_count: null,
        },
        row,
      );
    }

    for (const row of streaks) {
      push(
        {
          kind: 'streak_bonus',
          amount_ae: aettosToAe(row.amount_aettos),
          amount_recorded: true,
          occurred_at: iso(row.created_at),
          post_day: null,
          streak_days: row.streak_length ?? null,
          invite_count: null,
        },
        row,
      );
    }

    for (const row of milestones) {
      push(
        {
          kind: 'invite_milestone',
          // '0' is the unset default of this constant, not a real amount.
          amount_ae:
            PROFILE_X_INVITE_MILESTONE_REWARD_AMOUNT_AE &&
            PROFILE_X_INVITE_MILESTONE_REWARD_AMOUNT_AE !== '0'
              ? PROFILE_X_INVITE_MILESTONE_REWARD_AMOUNT_AE
              : null,
          amount_recorded: false,
          occurred_at: iso(row.created_at),
          post_day: null,
          streak_days: null,
          invite_count: row.threshold ?? null,
        },
        row,
      );
    }

    items.sort((a, b) => timeOf(b.occurred_at) - timeOf(a.occurred_at));

    const truncated =
      items.length > HISTORY_LIMIT ||
      perPost.length > HISTORY_LIMIT ||
      streaks.length > HISTORY_LIMIT ||
      milestones.length > HISTORY_LIMIT;

    return { items: items.slice(0, HISTORY_LIMIT), truncated };
  }
}

function iso(value: Date | null | undefined): string | null {
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString()
    : null;
}

function timeOf(value: string | null): number {
  return value ? Date.parse(value) : 0;
}

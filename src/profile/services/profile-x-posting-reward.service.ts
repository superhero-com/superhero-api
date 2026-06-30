import { AeSdkService } from '@/ae/ae-sdk.service';
import {
  X_API_KEY,
  X_API_KEY_SECRET,
  X_CLIENT_ID,
  X_CLIENT_SECRET,
} from '@/configs/social';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  In,
  IsNull,
  LessThanOrEqual,
  QueryFailedError,
  Repository,
  Not,
} from 'typeorm';
import { buildTxHash } from '@aeternity/aepp-sdk';
import { randomBytes } from 'crypto';
import {
  PROFILE_X_FOLLOWER_TIERS,
  PROFILE_X_ONBOARDING_REWARD_AMOUNT_AE,
  PROFILE_X_ONBOARDING_REWARD_ENABLED,
  PROFILE_X_ONBOARDING_REWARD_PRIVATE_KEY,
  PROFILE_X_ONBOARDING_THRESHOLD,
  PROFILE_X_PERPOST_REWARD_ENABLED,
  PROFILE_X_PERPOST_REWARD_PRIVATE_KEY,
  PROFILE_X_POSTING_REWARD_ENABLED,
  PROFILE_X_POSTING_REWARD_ENABLE_POST_FETCH,
  PROFILE_X_POSTING_REWARD_FETCH_TIMEOUT_MS,
  PROFILE_X_POSTING_REWARD_KEYWORDS,
  PROFILE_X_POSTING_REWARD_RETRY_BASE_SECONDS,
  PROFILE_X_POSTING_REWARD_RETRY_MAX_SECONDS,
  PROFILE_X_REFERRAL_LINK_BASE_URL,
  PROFILE_X_REWARD_DAILY_CAP_HOURS,
  PROFILE_X_REWARD_MIN_FOLLOWERS,
  PROFILE_X_REWARD_STREAK_BONUS_AMOUNT_AE,
  PROFILE_X_REWARD_STREAK_BONUS_ENABLED,
  PROFILE_X_REWARD_STREAK_BONUS_PRIVATE_KEY,
  PROFILE_X_REWARD_STREAK_LENGTH,
} from '../profile.constants';
import { Account } from '@/account/entities/account.entity';
import { ACTIVE_NETWORK } from '@/configs/network';
import { fetchJson } from '@/utils/common';
import { microTimeToDate } from '@/mdw-sync/utils/common';
import { ProfileXPostingReward } from '../entities/profile-x-posting-reward.entity';
import { ProfileXPostRewardLedger } from '../entities/profile-x-post-reward-ledger.entity';
import { ProfileXStreakBonusReward } from '../entities/profile-x-streak-bonus-reward.entity';
import { ProfileXApiClientService } from './profile-x-api-client.service';
import { ProfileSpendQueueService } from './profile-spend-queue.service';
import {
  extractReferralHost,
  getRewardAmountAettos,
  isValidAeAmount,
  isValidPositiveInteger,
  matchesReferralCode,
  normalizeXUsername,
  processAddressWithGuard,
  resolveFollowerTier,
} from './profile-x-reward.util';

interface XUserProfile {
  id: string;
  username: string;
  followersCount: number | null;
}

interface XTweetItem {
  id: string;
  text: string;
  urls: string[];
  createdAt: Date | null;
}

interface XPostFetchResult {
  posts: XTweetItem[];
  newestTweetId: string | null;
  truncated: boolean;
}

type PublicPostingRewardStatus = 'not_started' | 'pending' | 'paid' | 'failed';
type PublicPaymentStatus = 'not_started' | 'pending' | 'paid' | 'failed';

type PublicPostingRewardStatusPayload = {
  status: PublicPostingRewardStatus;
  x_username: string | null;
  x_user_id: string | null;
  referral_code: string | null;
  referral_link: string | null;
  onboarding_status: PublicPaymentStatus;
  onboarding_threshold: number;
  qualified_posts_count: number;
  remaining_to_goal: number;
  per_post_total_paid_count: number;
  per_post_total_paid_aettos: string;
  follower_count: number | null;
  min_followers_required: number;
  follower_tier_index: number | null;
  tier_amount_ae: string | null;
  current_streak_days: number;
  streak_required: number;
  streak_bonus_status: PublicPaymentStatus;
  streak_bonus_paid_count: number;
  next_check_allowed_at: Date | null;
  tx_hash: string | null;
  error: string | null;
};

@Injectable()
export class ProfileXPostingRewardService {
  private readonly logger = new Logger(ProfileXPostingRewardService.name);
  private static readonly ADDRESS_REGEX = /^ak_[1-9A-HJ-NP-Za-km-z]+$/;
  private static readonly REFERRAL_CODE_ALPHABET =
    'abcdefghijklmnopqrstuvwxyz0123456789';
  private static readonly DEFAULT_MAX_TWEET_PAGE_COUNT = 20;
  private static readonly MAX_RECENT_SOURCE_TX_HASHES = 5000;
  private static readonly LEDGER_BATCH_SIZE = 200;
  // Safety bound on the per-run drain loop (200 * 25 = 5000 rows), well above the
  // most a single capped scan can ledger; prevents an unbounded loop.
  private static readonly MAX_LEDGER_DRAIN_RUNS = 25;
  private static readonly STREAK_BONUS_BATCH_SIZE = 50;
  /**
   * After this many consecutive failed X user lookups the row stops calling X
   * entirely (one un-resolvable username must not cost one paid lookup per day
   * forever). A successful lookup or a fresh on-chain re-link resets the count.
   */
  private static readonly MAX_CONSECUTIVE_LOOKUP_FAILURES = 5;
  private static readonly ONBOARDING_PAYOUT_IN_PROGRESS_TX_HASH =
    '__posting_reward_payout_in_progress__';
  private static readonly PERPOST_PAYOUT_IN_PROGRESS_TX_HASH =
    '__per_post_payout_in_progress__';
  private static readonly STREAK_PAYOUT_IN_PROGRESS_TX_HASH =
    '__streak_bonus_payout_in_progress__';
  private readonly processingByAddress = new Map<string, Promise<void>>();
  private readonly recentSourceTxHashes = new Set<string>();
  private readonly recentSourceTxHashQueue: string[] = [];

  constructor(
    @InjectRepository(ProfileXPostingReward)
    private readonly postingRewardRepository: Repository<ProfileXPostingReward>,
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
    private readonly dataSource: DataSource,
    private readonly aeSdkService: AeSdkService,
    private readonly profileSpendQueueService: ProfileSpendQueueService,
    private readonly profileXApiClientService: ProfileXApiClientService,
    @InjectRepository(ProfileXPostRewardLedger)
    private readonly postRewardLedgerRepository: Repository<ProfileXPostRewardLedger>,
    @InjectRepository(ProfileXStreakBonusReward)
    private readonly streakBonusRewardRepository: Repository<ProfileXStreakBonusReward>,
  ) {}

  /* ------------------------------------------------------------------ */
  /* Candidate intake (from on-chain X link events)                      */
  /* ------------------------------------------------------------------ */

  async upsertVerifiedCandidate(
    address: string,
    xUsername: string,
    verificationMicroTime?: string,
  ): Promise<void> {
    if (!PROFILE_X_POSTING_REWARD_ENABLED) {
      return;
    }
    const normalizedXUsername = normalizeXUsername(xUsername);
    if (!normalizedXUsername) {
      this.logger.warn(
        `Skipping X posting reward candidate, invalid x username: ${xUsername}`,
      );
      return;
    }
    if (!ProfileXPostingRewardService.ADDRESS_REGEX.test(address || '')) {
      this.logger.warn(
        `Skipping X posting reward candidate, invalid account address: ${address}`,
      );
      return;
    }

    const existingReward = await this.postingRewardRepository.findOne({
      where: { address },
    });
    const rewardEntry =
      existingReward ||
      this.postingRewardRepository.create({
        address,
        qualified_posts_count: 0,
        current_streak_days: 0,
        x_lookup_failure_count: 0,
      });
    // A fresh on-chain re-link is the recovery path for rows blocked after
    // repeated failed lookups (it costs the user a transaction, so it cannot
    // be spammed for free).
    rewardEntry.x_lookup_failure_count = 0;
    const verificationDate = this.microTimeToDate(verificationMicroTime);
    if (!rewardEntry.verified_at) {
      rewardEntry.verified_at = verificationDate || new Date();
    } else if (
      verificationDate &&
      rewardEntry.verified_at &&
      verificationDate.getTime() < rewardEntry.verified_at.getTime()
    ) {
      rewardEntry.verified_at = verificationDate;
    }
    // A re-link to a DIFFERENT X handle must drop the previous handle's cached
    // identity/scan state so the next scan starts fresh against the new account.
    this.resetStaleXIdentityState(rewardEntry, normalizedXUsername);
    rewardEntry.x_username = normalizedXUsername;
    if (
      rewardEntry.status !== 'paid' &&
      rewardEntry.status !== 'blocked_x_identity_conflict'
    ) {
      rewardEntry.status = 'pending';
      rewardEntry.error = null;
    }
    // On-demand model: do NOT scan X here (that would bypass the daily cap and
    // spend metered API budget on every link event). The first user-triggered
    // check performs the (capped) scan. We only persist the candidate row and
    // mint the referral link the user needs in order to post.
    // Explicit save: ensureReferralCodePersisted only writes when it mints a
    // new code, but the username/status/failure-count updates above must
    // persist on re-links of rows that already have a code.
    await this.postingRewardRepository.save(rewardEntry);
    await this.ensureReferralCodePersisted(rewardEntry);
  }

  async upsertVerifiedCandidateFromTx(
    address: string,
    xUsername: string,
    verificationMicroTime?: string,
    sourceTxHash?: string,
  ): Promise<void> {
    if (!PROFILE_X_POSTING_REWARD_ENABLED) {
      return;
    }
    const normalizedHash = String(sourceTxHash || '').trim();
    if (normalizedHash) {
      if (this.recentSourceTxHashes.has(normalizedHash)) {
        return;
      }
      this.recentSourceTxHashes.add(normalizedHash);
      this.recentSourceTxHashQueue.push(normalizedHash);
      if (
        this.recentSourceTxHashQueue.length >
        ProfileXPostingRewardService.MAX_RECENT_SOURCE_TX_HASHES
      ) {
        const oldest = this.recentSourceTxHashQueue.shift();
        if (oldest) {
          this.recentSourceTxHashes.delete(oldest);
        }
      }
    }
    await this.upsertVerifiedCandidate(
      address,
      xUsername,
      verificationMicroTime,
    );
  }

  /* ------------------------------------------------------------------ */
  /* Referral link                                                       */
  /* ------------------------------------------------------------------ */

  async getOrCreateReferralLink(
    address: string,
  ): Promise<{ code: string; link: string }> {
    this.assertValidAddress(address);
    if (!PROFILE_X_POSTING_REWARD_ENABLED) {
      throw new HttpException(
        {
          status: HttpStatus.SERVICE_UNAVAILABLE,
          message: 'Posting rewards are temporarily unavailable.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const reward = await this.bootstrapCandidate(address);
    const code = await this.ensureReferralCodePersisted(reward);
    return { code, link: this.buildReferralLink(code) };
  }

  private buildReferralLink(code: string): string {
    if (!PROFILE_X_REFERRAL_LINK_BASE_URL) {
      return code;
    }
    const base = PROFILE_X_REFERRAL_LINK_BASE_URL.replace(/\/+$/, '');
    return `${base}?ref=${encodeURIComponent(code)}`;
  }

  private async ensureReferralCodePersisted(
    reward: ProfileXPostingReward,
  ): Promise<string> {
    if (reward.referral_code) {
      return reward.referral_code;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      reward.referral_code = this.generateReferralCode();
      try {
        await this.postingRewardRepository.save(reward);
        return reward.referral_code;
      } catch (error) {
        if (!this.isReferralCodeUniqueConstraintError(error) || attempt === 2) {
          throw error;
        }
        reward.referral_code = null;
      }
    }
    throw new BadRequestException('Failed to generate unique referral code');
  }

  private generateReferralCode(): string {
    const alphabet = ProfileXPostingRewardService.REFERRAL_CODE_ALPHABET;
    // Rejection sampling: discard bytes in the biased tail so every alphabet
    // symbol is equiprobable (256 % 36 != 0 would otherwise over-weight a-d).
    const usableCeiling = Math.floor(256 / alphabet.length) * alphabet.length;
    let code = '';
    while (code.length < 12) {
      const bytes = randomBytes(12);
      for (let i = 0; i < bytes.length && code.length < 12; i += 1) {
        const byte = bytes[i];
        if (byte >= usableCeiling) {
          continue;
        }
        code += alphabet[byte % alphabet.length];
      }
    }
    return code;
  }

  /* ------------------------------------------------------------------ */
  /* Status read (side-effect free)                                      */
  /* ------------------------------------------------------------------ */

  async getRewardStatus(
    address: string,
  ): Promise<PublicPostingRewardStatusPayload> {
    this.assertValidAddress(address);
    const reward = await this.postingRewardRepository.findOne({
      where: { address },
    });
    if (!PROFILE_X_POSTING_REWARD_ENABLED) {
      if (reward?.status === 'paid') {
        // Still surface settled per-post history (side-effect-free read) so a
        // paid user's totals don't drop to zero while the program is toggled off.
        return this.toPublicRewardStatus(
          reward,
          await this.getPerPostTotals(address),
        );
      }
      return {
        ...this.toPublicRewardStatus(null, null),
        error: 'Posting rewards are temporarily unavailable.',
      };
    }
    const ledgerTotals = reward ? await this.getPerPostTotals(address) : null;
    const streakBonusStatus = reward
      ? await this.resolveStreakBonusStatus(reward)
      : undefined;
    const payload = this.toPublicRewardStatus(
      reward,
      ledgerTotals,
      streakBonusStatus,
    );
    // The reward row keeps the X identity it was last verified with, but the
    // on-chain link can be removed afterwards. The recheck path already refuses
    // to run when the account has no current X link (bootstrapCandidate); mirror
    // that here so the read-only status does not keep advertising an X account
    // the user has since unlinked. Earned/paid history (onboarding + per-post +
    // streak totals) is preserved — only the live identity/scan fields are
    // masked, and the payload self-heals once the user re-links.
    if (reward && (await this.isXIdentityUnlinked(address, reward))) {
      return this.maskUnlinkedXIdentity(payload);
    }
    return payload;
  }

  /**
   * True when the reward row still references an X identity that is no longer
   * the account's currently linked X handle (unlinked, or re-linked to a
   * different handle that has not been re-verified yet).
   */
  private async isXIdentityUnlinked(
    address: string,
    reward: ProfileXPostingReward,
  ): Promise<boolean> {
    const rewardUsername = normalizeXUsername(reward.x_username || '');
    if (!rewardUsername) {
      return false;
    }
    const account = await this.accountRepository.findOne({
      where: { address },
    });
    const linkedXUsername = normalizeXUsername(account?.links?.x || '');
    return linkedXUsername !== rewardUsername;
  }

  /**
   * Strip the live X identity and active-scan fields from a status payload
   * while keeping settled payout history (onboarding/per-post/streak totals and
   * tx hash). Used when the account's X link has been removed.
   */
  private maskUnlinkedXIdentity(
    payload: PublicPostingRewardStatusPayload,
  ): PublicPostingRewardStatusPayload {
    return {
      ...payload,
      status: payload.onboarding_status === 'paid' ? 'paid' : 'not_started',
      x_username: null,
      x_user_id: null,
      referral_code: null,
      referral_link: null,
      qualified_posts_count: 0,
      remaining_to_goal: payload.onboarding_threshold,
      follower_count: null,
      follower_tier_index: null,
      tier_amount_ae: null,
      current_streak_days: 0,
      next_check_allowed_at: null,
      error: null,
    };
  }

  /**
   * Streak-bonus payment state derived from the recurring bonus rows: the
   * latest completion drives the status (so a payout stuck mid-flight after a
   * crash or a `failed` send is visible instead of masquerading as
   * `not_started`), and the paid count reports how many streak bonuses have
   * been settled so far.
   */
  private async resolveStreakBonusStatus(
    reward: ProfileXPostingReward,
  ): Promise<{ status: PublicPaymentStatus; paidCount: number }> {
    const bonusRows = await this.streakBonusRewardRepository.find({
      where: { address: reward.address },
    });
    if (bonusRows.length === 0) {
      return { status: 'not_started', paidCount: 0 };
    }
    const paidCount = bonusRows.filter((row) => row.status === 'paid').length;
    const latest = bonusRows.reduce((current, row) =>
      Number(row.id) > Number(current.id) ? row : current,
    );
    if (latest.status === 'paid') {
      return { status: 'paid', paidCount };
    }
    if (latest.status === 'failed' || latest.status === 'skipped') {
      return { status: 'failed', paidCount };
    }
    return { status: 'pending', paidCount };
  }

  private async getPerPostTotals(
    address: string,
  ): Promise<{ count: number; aettos: string }> {
    // Aggregate in SQL (one scalar row) instead of streaming every paid ledger
    // row into the process. The `~ '^[0-9]+$'` guard keeps malformed amounts out
    // of the NUMERIC cast so a single bad row can't fail the whole query.
    const raw = await this.postRewardLedgerRepository
      .createQueryBuilder('ledger')
      .select('COUNT(*)', 'count')
      .addSelect(
        'COALESCE(SUM(CAST(ledger.amount_aettos AS NUMERIC)), 0)',
        'aettos',
      )
      .where('ledger.address = :address', { address })
      .andWhere('ledger.status = :status', { status: 'paid' })
      .andWhere('ledger.amount_aettos ~ :numericPattern', {
        numericPattern: '^[0-9]+$',
      })
      .getRawOne<{ count: string; aettos: string }>();
    const aettosRaw = raw?.aettos != null ? String(raw.aettos) : '0';
    return {
      count: Number(raw?.count || 0),
      // NUMERIC sums come back integer-valued here, but defensively drop any
      // fractional suffix so the public payload is always a clean aettos string.
      aettos: aettosRaw.includes('.') ? aettosRaw.split('.')[0] : aettosRaw,
    };
  }

  /* ------------------------------------------------------------------ */
  /* On-demand check (signature gated by the controller)                 */
  /* ------------------------------------------------------------------ */

  async requestManualRecheck(
    address: string,
  ): Promise<PublicPostingRewardStatusPayload> {
    this.assertValidAddress(address);
    if (!PROFILE_X_POSTING_REWARD_ENABLED) {
      throw new HttpException(
        {
          status: HttpStatus.SERVICE_UNAVAILABLE,
          message: 'Posting rewards are temporarily unavailable.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const reward = await this.prepareCheckCandidate(address);
    if (reward.status === 'blocked_x_identity_conflict') {
      return this.getRewardStatus(address);
    }

    // 1. Recover any pending/failed payouts first — this never calls X, so it
    //    must not be blocked by the daily cap. Reuse the row prepareCheckCandidate
    //    just loaded/saved to avoid an immediate re-read. This recovery pass runs
    //    before any new claims, so a lingering in-progress sentinel here is a
    //    genuinely stuck payout worth logging.
    await this.runPayouts(address, reward, { logStuckPayouts: true });

    // 2. Atomic, DB-enforced hard cap: at most one X API scan per address per
    //    window. Concurrent/duplicate requests and restarts cannot exceed it.
    const priorScanAt = reward.last_x_api_scan_at ?? null;
    const claimed = await this.claimDailyScanSlot(address);
    if (!claimed) {
      const latest = await this.postingRewardRepository.findOne({
        where: { address },
      });
      throw new HttpException(
        {
          status: HttpStatus.TOO_MANY_REQUESTS,
          message: 'X reward check is cooling down. Try again later.',
          nextAllowedAt: this.computeNextCheckAllowedAt(
            latest?.last_x_api_scan_at || null,
          )?.toISOString(),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 3. Run the (capped) scan + payouts. A HANDLED scan failure (X outage, etc.)
    //    returns an error status without throwing, so it correctly keeps the slot
    //    consumed (fail-closed for the X budget). An UNEXPECTED throw (e.g. a DB
    //    failure) is neither budget abuse nor the user's fault: roll the slot
    //    back so they are not locked out for the whole window, and surface the
    //    failure instead of returning a misleading success.
    try {
      await this.processAddressWithGuard(address);
    } catch (error) {
      await this.releaseDailyScanSlot(address, priorScanAt);
      this.logger.error(
        `X reward recheck failed for ${address} after claiming the scan slot; slot released`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new HttpException(
        {
          status: HttpStatus.SERVICE_UNAVAILABLE,
          message: 'X reward check could not be completed. Please try again.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.getRewardStatus(address);
  }

  /**
   * Atomically consume this address's daily X API scan slot. Returns true only
   * for the single caller that flips `last_x_api_scan_at`; concurrent callers
   * and replays within the window get false. Set-before-fetch (fail-closed): a
   * HANDLED scan failure (e.g. an X outage, which records an error status and
   * returns rather than throwing) still consumes the slot, so X outages cannot
   * be used to drain the API budget. An UNEXPECTED scan failure (a thrown infra
   * error such as a DB outage) is rolled back by `releaseDailyScanSlot` — so a
   * transient blip neither locks the user out for the window nor hides behind a
   * success response.
   */
  private async claimDailyScanSlot(address: string): Promise<boolean> {
    const capHours = isValidPositiveInteger(PROFILE_X_REWARD_DAILY_CAP_HOURS)
      ? PROFILE_X_REWARD_DAILY_CAP_HOURS
      : 24;
    const cutoff = new Date(Date.now() - capHours * 3600 * 1000);
    const result = await this.postingRewardRepository
      .createQueryBuilder()
      .update(ProfileXPostingReward)
      .set({ last_x_api_scan_at: new Date() })
      .where('address = :address', { address })
      .andWhere(
        '(last_x_api_scan_at IS NULL OR last_x_api_scan_at <= :cutoff)',
        { cutoff },
      )
      .execute();
    return Number(result?.affected || 0) > 0;
  }

  /**
   * Roll back a scan-slot claim after the guarded scan threw UNEXPECTEDLY, so an
   * infra failure (e.g. a DB error) does not cost the user their daily slot. Only
   * the slot this request just claimed is restored; a handled X failure returns
   * normally and never reaches here, so the fail-closed X-budget guard stays
   * intact. The daily cap already serialized this address (a concurrent claim
   * would have been refused), so restoring the prior timestamp cannot clobber
   * another caller's claim.
   */
  private async releaseDailyScanSlot(
    address: string,
    priorScanAt: Date | null,
  ): Promise<void> {
    await this.postingRewardRepository.update(
      { address },
      { last_x_api_scan_at: priorScanAt },
    );
  }

  private computeNextCheckAllowedAt(lastScanAt: Date | null): Date | null {
    if (!lastScanAt) {
      return null;
    }
    const capHours = isValidPositiveInteger(PROFILE_X_REWARD_DAILY_CAP_HOURS)
      ? PROFILE_X_REWARD_DAILY_CAP_HOURS
      : 24;
    return new Date(new Date(lastScanAt).getTime() + capHours * 3600 * 1000);
  }

  /**
   * When the X handle linked to an address changes, the cached X identity and
   * scan state from the PREVIOUS handle must not carry over: resolveXUserProfile
   * prefers the cached `x_user_id`, so without this reset the next scan would
   * resolve, accrue and PAY against the old X account (or count its tweets
   * toward onboarding/streak). Earned history — the per-post ledger and streak
   * bonus rows, keyed by the old `x_user_id` — is intentionally left intact
   * (anti-sybil; immutable record of what was already paid). Returns true when a
   * reset was applied. No-op when the handle is unchanged or none was stored.
   */
  private resetStaleXIdentityState(
    reward: ProfileXPostingReward,
    newUsername: string,
  ): boolean {
    const previous = normalizeXUsername(reward.x_username || '');
    if (!previous || previous === newUsername) {
      return false;
    }
    reward.x_user_id = null;
    reward.last_scanned_tweet_id = null;
    reward.follower_count = null;
    reward.follower_tier_index = null;
    reward.follower_snapshot_at = null;
    reward.last_qualifying_post_day = null;
    reward.current_streak_days = 0;
    reward.qualified_posts_count = 0;
    reward.x_lookup_failure_count = 0;
    return true;
  }

  private async bootstrapCandidate(
    address: string,
  ): Promise<ProfileXPostingReward> {
    const account = await this.accountRepository.findOne({
      where: { address },
    });
    const linkedXUsername = normalizeXUsername(account?.links?.x || '');
    if (!linkedXUsername) {
      throw new BadRequestException(
        'X profile is not linked for this address yet',
      );
    }
    let reward = await this.postingRewardRepository.findOne({
      where: { address },
    });
    if (!reward) {
      reward = this.postingRewardRepository.create({
        address,
        x_username: linkedXUsername,
        qualified_posts_count: 0,
        current_streak_days: 0,
        x_lookup_failure_count: 0,
        status: 'pending',
        verified_at: new Date(),
      });
      reward = await this.postingRewardRepository.save(reward);
      return reward;
    }
    this.resetStaleXIdentityState(reward, linkedXUsername);
    reward.x_username = linkedXUsername;
    if (!reward.verified_at) {
      reward.verified_at = new Date();
    }
    return reward;
  }

  private async prepareCheckCandidate(
    address: string,
  ): Promise<ProfileXPostingReward> {
    const reward = await this.bootstrapCandidate(address);
    reward.error = null;
    await this.postingRewardRepository.save(reward);
    await this.ensureReferralCodePersisted(reward);
    return reward;
  }

  private async processAddressWithGuard(address: string): Promise<void> {
    // The in-flight guard's helper swallows (logs) a thrown scan error so the
    // fire-and-forget guard never rejects. Capture it here so the caller
    // (requestManualRecheck) can react — release the daily scan slot and surface
    // the failure — instead of the error being hidden behind a success response.
    let workError: unknown = null;
    await processAddressWithGuard({
      address,
      processingByAddress: this.processingByAddress,
      workFactory: async () => {
        try {
          await this.processAddressInternal(address);
        } catch (error) {
          if (this.isXIdentityUniqueConstraintError(error)) {
            await this.postingRewardRepository.update(
              { address },
              {
                status: 'blocked_x_identity_conflict',
                error: 'X identity already claimed by another reward row',
              },
            );
            return;
          }
          workError = error;
          throw error;
        }
      },
      logger: this.logger,
      errorMessage: `Failed to process X posting reward for ${address}`,
    });
    if (workError) {
      throw workError;
    }
  }

  /* ------------------------------------------------------------------ */
  /* The scan: fetch posts, ledger per-post, update onboarding + streak  */
  /* ------------------------------------------------------------------ */

  private async processAddressInternal(address: string): Promise<void> {
    const rewardEntry = await this.postingRewardRepository.findOne({
      where: { address },
    });
    if (!rewardEntry) {
      return;
    }
    if (rewardEntry.status === 'blocked_x_identity_conflict') {
      return;
    }

    rewardEntry.last_attempt_at = new Date();
    const normalizedXUsername = normalizeXUsername(
      rewardEntry.x_username || '',
    );
    if (!normalizedXUsername) {
      rewardEntry.error = 'missing_x_username';
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }
    rewardEntry.x_username = normalizedXUsername;

    if (PROFILE_X_POSTING_REWARD_KEYWORDS.length === 0) {
      rewardEntry.error = 'missing_keywords';
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }
    if (
      !ProfileXPostingRewardService.ADDRESS_REGEX.test(
        rewardEntry.address || '',
      )
    ) {
      rewardEntry.error = 'invalid_address';
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }
    if (PROFILE_X_POSTING_REWARD_ENABLE_POST_FETCH === false) {
      rewardEntry.error = 'post_fetch_disabled';
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }

    if (
      Number(rewardEntry.x_lookup_failure_count || 0) >=
      ProfileXPostingRewardService.MAX_CONSECUTIVE_LOOKUP_FAILURES
    ) {
      // Do not spend a single X API call on a username that repeatedly failed
      // to resolve; the user recovers by re-linking on-chain.
      rewardEntry.error = 'x_user_lookup_blocked';
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }

    const xUserProfile = await this.resolveXUserProfile(
      rewardEntry.x_user_id,
      normalizedXUsername,
    );
    if (!xUserProfile) {
      rewardEntry.x_lookup_failure_count =
        Number(rewardEntry.x_lookup_failure_count || 0) + 1;
      rewardEntry.error = 'x_user_lookup_failed';
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }
    rewardEntry.x_lookup_failure_count = 0;
    rewardEntry.x_username = normalizeXUsername(xUserProfile.username);
    rewardEntry.x_user_id = xUserProfile.id;
    if (xUserProfile.followersCount !== null) {
      rewardEntry.follower_count = xUserProfile.followersCount;
      rewardEntry.follower_snapshot_at = new Date();
    }
    const tier = resolveFollowerTier(
      PROFILE_X_FOLLOWER_TIERS || [],
      Number(rewardEntry.follower_count || 0),
    );
    rewardEntry.follower_tier_index = tier ? tier.index : null;

    // Bound-identity guard: once an address has earned with one X identity it is
    // committed to it. Re-linking a DIFFERENT handle (a new x_user_id) must NOT
    // start a fresh round of per-post/streak earning — onboarding is already
    // once-per-address, so without this a paid address could farm per-post and
    // streak rewards across unlimited handles. A genuine handle RENAME keeps the
    // same x_user_id and passes. Settled history (onboarding `paid` status, the
    // ledger, streak rows) is preserved; only NEW accrual for the new identity is
    // refused, and this short-circuits BEFORE the (paid) posts fetch.
    if (
      rewardEntry.rewarded_x_user_id &&
      rewardEntry.rewarded_x_user_id !== xUserProfile.id
    ) {
      rewardEntry.error = 'x_identity_already_rewarded';
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }

    // Any active row already holding this x_user_id would make our save below
    // fail on the unique index anyway, so block BEFORE the (paid) posts fetch
    // instead of after it. Username-only conflicts still block only when the
    // other row is paid (the id may simply not be resolved yet on either side).
    const conflictingReward = await this.findConflictingReward(
      this.postingRewardRepository,
      rewardEntry.address,
      xUserProfile.id,
      rewardEntry.x_username,
    );
    if (
      conflictingReward &&
      (conflictingReward.x_user_id === xUserProfile.id ||
        conflictingReward.status === 'paid')
    ) {
      rewardEntry.status = 'blocked_x_identity_conflict';
      rewardEntry.error = 'x_identity_already_rewarded';
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }

    // Participation gate: below the minimum follower count nothing accrues and
    // the (paid) posts fetch is skipped entirely. Already-accrued payouts still
    // settle through runPayouts.
    if (
      Number(rewardEntry.follower_count || 0) < PROFILE_X_REWARD_MIN_FOLLOWERS
    ) {
      rewardEntry.error =
        rewardEntry.follower_count == null
          ? 'follower_count_unavailable'
          : 'below_min_followers';
      await this.postingRewardRepository.save(rewardEntry);
      await this.runPayouts(address, rewardEntry);
      return;
    }

    const postsResult = await this.fetchUserPostsSince(
      xUserProfile.id,
      rewardEntry.last_scanned_tweet_id,
      rewardEntry.last_scanned_tweet_id ? null : rewardEntry.verified_at,
    );
    if (!postsResult) {
      rewardEntry.error = 'x_posts_fetch_failed';
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }

    // The two paths run together: a post carrying the user's referral link is
    // a Path-2 (per-post + streak) post AND also finalizes Path 1 (onboarding),
    // so a user may start with the referral link and complete both at once. A
    // keyword post (any configured keyword) without the referral link counts
    // for Path 1 only.
    let onboardingNewCount = 0;
    const referralPosts: XTweetItem[] = [];
    const perPostLedgerCandidates: XTweetItem[] = [];
    for (const post of postsResult.posts) {
      const referralMatch = this.matchesReferral(
        post,
        rewardEntry.referral_code,
      );
      if (referralMatch) {
        referralPosts.push(post);
        perPostLedgerCandidates.push(post);
      }
      if (referralMatch || this.matchesKeyword(post)) {
        onboardingNewCount += 1;
      }
    }

    rewardEntry.qualified_posts_count =
      Number(rewardEntry.qualified_posts_count || 0) + onboardingNewCount;
    // Bind the address to this X identity once it actually EARNS with it — a
    // referral post (per-post / streak), or meeting the onboarding threshold
    // while onboarding payouts are enabled. A later re-link to a DIFFERENT handle
    // is then rejected by the bound-identity guard above, so a paid address
    // cannot farm rewards across handles. Binding on real earning (not a bare
    // keyword mention that pays nothing) avoids locking out a user who merely
    // linked the wrong handle before earning. A rename keeps the same id and is
    // unaffected.
    const onboardingThreshold = isValidPositiveInteger(
      PROFILE_X_ONBOARDING_THRESHOLD,
    )
      ? PROFILE_X_ONBOARDING_THRESHOLD
      : 1;
    const willEarnOnboarding =
      PROFILE_X_ONBOARDING_REWARD_ENABLED &&
      Number(rewardEntry.qualified_posts_count || 0) >= onboardingThreshold;
    if (
      !rewardEntry.rewarded_x_user_id &&
      (referralPosts.length > 0 || willEarnOnboarding)
    ) {
      rewardEntry.rewarded_x_user_id = rewardEntry.x_user_id;
    }
    // The cursor is forward-only (`since_id`), so we always advance to the newest
    // tweet we saw — including on truncation. A truncated scan keeps the 2000
    // newest tweets (the page cap); the older overflow is intentionally not
    // counted (it bounds payout exposure and cannot be reached by a forward
    // cursor anyway). NOT advancing here would re-fetch the same page set and
    // double-count keyword posts, so advancing is the correct, non-regressive
    // choice. `x_posts_scan_truncated` is surfaced as an informational notice.
    if (postsResult.newestTweetId) {
      rewardEntry.last_scanned_tweet_id = postsResult.newestTweetId;
    }
    rewardEntry.error = postsResult.truncated ? 'x_posts_scan_truncated' : null;

    const completedStreakDays = this.updateStreak(rewardEntry, referralPosts);
    const bonusRows = this.buildStreakBonusRows(
      rewardEntry,
      completedStreakDays,
    );

    // The streak reset and the completion rows must land atomically: a crash
    // between them would either lose a completion or (worse) let a stale high
    // streak mint an extra completion on the next qualifying day.
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(ProfileXPostingReward).save(rewardEntry);
      if (bonusRows.length > 0) {
        await manager
          .getRepository(ProfileXStreakBonusReward)
          .createQueryBuilder()
          .insert()
          .into(ProfileXStreakBonusReward)
          .values(bonusRows)
          .orIgnore()
          .execute();
      }
      // Ledger the per-post rewards in the SAME transaction that advances the
      // forward scan cursor (last_scanned_tweet_id). A crash between the cursor
      // advance and these inserts would otherwise permanently skip these posts
      // (the next scan starts strictly after them), silently losing their
      // per-post reward. The (x_user_id, tweet_id) unique index + orIgnore keep
      // the inserts idempotent if the transaction is retried.
      for (const post of perPostLedgerCandidates) {
        await this.ledgerPerPost(
          rewardEntry,
          post,
          tier,
          manager.getRepository(ProfileXPostRewardLedger),
        );
      }
    });

    // rewardEntry was just saved with the post-scan counts/streak, so reuse it
    // rather than re-reading the same row inside runPayouts.
    await this.runPayouts(address, rewardEntry);
  }

  /* ------------------------------------------------------------------ */
  /* Streak                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Advance the consecutive-day streak with the new referral posts and return
   * the UTC days on which a full streak completed. The bonus is RECURRING:
   * every time the streak reaches the configured length it completes (the day
   * is returned so a bonus row can be recorded) and the counter resets, so the
   * user starts earning the next bonus from zero.
   */
  private updateStreak(
    reward: ProfileXPostingReward,
    referralPosts: XTweetItem[],
  ): string[] {
    const days = Array.from(
      new Set(
        referralPosts
          .map((post) => this.toUtcDay(post.createdAt))
          .filter((day): day is string => !!day),
      ),
    ).sort();
    if (days.length === 0) {
      return [];
    }
    const streakLength = isValidPositiveInteger(PROFILE_X_REWARD_STREAK_LENGTH)
      ? PROFILE_X_REWARD_STREAK_LENGTH
      : 10;
    const completedDays: string[] = [];
    let last = reward.last_qualifying_post_day || null;
    let streak = Number(reward.current_streak_days || 0);
    for (const day of days) {
      if (!last) {
        streak = 1;
      } else {
        const diff = this.utcDayDiff(last, day);
        if (diff === 0) {
          continue;
        }
        if (diff < 0) {
          continue;
        }
        streak = diff === 1 ? streak + 1 : 1;
      }
      last = day;
      if (streak >= streakLength) {
        completedDays.push(day);
        streak = 0;
      }
    }
    reward.last_qualifying_post_day = last;
    reward.current_streak_days = streak;
    return completedDays;
  }

  /**
   * Build the (idempotent) completion rows for the streak bonuses earned in
   * this scan. The `(x_user_id, streak_completed_day)` unique constraint plus
   * insert-or-ignore make each completion payable at most once, and the amount
   * is frozen at completion time like the per-post ledger.
   */
  private buildStreakBonusRows(
    reward: ProfileXPostingReward,
    completedDays: string[],
  ): Array<Partial<ProfileXStreakBonusReward>> {
    if (
      !PROFILE_X_REWARD_STREAK_BONUS_ENABLED ||
      completedDays.length === 0 ||
      !reward.x_user_id
    ) {
      return [];
    }
    if (!isValidAeAmount(PROFILE_X_REWARD_STREAK_BONUS_AMOUNT_AE)) {
      this.logger.warn('Skipping streak bonus, invalid amount');
      return [];
    }
    const amountAettos = getRewardAmountAettos({
      amountAe: PROFILE_X_REWARD_STREAK_BONUS_AMOUNT_AE,
      logger: this.logger,
      rewardLabel: 'X streak bonus',
    });
    if (!amountAettos) {
      return [];
    }
    const streakLength = isValidPositiveInteger(PROFILE_X_REWARD_STREAK_LENGTH)
      ? PROFILE_X_REWARD_STREAK_LENGTH
      : 10;
    return completedDays.map((day) => ({
      address: reward.address,
      x_user_id: reward.x_user_id as string,
      streak_length: streakLength,
      streak_completed_day: day,
      amount_aettos: amountAettos,
      status: 'pending' as const,
      tx_hash: null,
      error: null,
      retry_count: 0,
      next_retry_at: null,
    }));
  }

  private toUtcDay(value: Date | null): string | null {
    if (!value || Number.isNaN(value.getTime())) {
      return null;
    }
    return value.toISOString().slice(0, 10);
  }

  private utcDayDiff(fromDay: string, toDay: string): number {
    const from = Date.parse(`${fromDay}T00:00:00Z`);
    const to = Date.parse(`${toDay}T00:00:00Z`);
    if (Number.isNaN(from) || Number.isNaN(to)) {
      return Number.NaN;
    }
    return Math.round((to - from) / 86_400_000);
  }

  /* ------------------------------------------------------------------ */
  /* Per-post ledger                                                     */
  /* ------------------------------------------------------------------ */

  private async ledgerPerPost(
    reward: ProfileXPostingReward,
    post: XTweetItem,
    tier: ReturnType<typeof resolveFollowerTier>,
    ledgerRepo: Repository<ProfileXPostRewardLedger> = this
      .postRewardLedgerRepository,
  ): Promise<void> {
    if (!reward.x_user_id || !tier) {
      return;
    }
    // The UTC day anchors the one-rewarded-post-per-day cap (unique index on
    // (x_user_id, tweet_utc_day) + insert-or-ignore). A tweet without a usable
    // created_at cannot be capped, so it earns nothing — fail-closed.
    const tweetUtcDay = this.toUtcDay(post.createdAt);
    if (!tweetUtcDay) {
      return;
    }
    const amountAettos = getRewardAmountAettos({
      amountAe: tier.amountAe,
      logger: this.logger,
      rewardLabel: 'X per-post reward',
    });
    if (!amountAettos) {
      return;
    }
    await ledgerRepo
      .createQueryBuilder()
      .insert()
      .into(ProfileXPostRewardLedger)
      .values({
        address: reward.address,
        x_user_id: reward.x_user_id,
        tweet_id: post.id,
        tweet_created_at: post.createdAt,
        tweet_utc_day: tweetUtcDay,
        reward_kind: 'per_post',
        amount_aettos: amountAettos,
        follower_count_at_post: reward.follower_count ?? null,
        tier_index_at_post: tier.index,
        status: 'pending',
      })
      .orIgnore()
      .execute();
  }

  /* ------------------------------------------------------------------ */
  /* Payouts (idempotent, serialized through the spend queue)            */
  /* ------------------------------------------------------------------ */

  private async runPayouts(
    address: string,
    preloadedReward?: ProfileXPostingReward | null,
    options?: { logStuckPayouts?: boolean },
  ): Promise<void> {
    // Reuse the freshly-loaded/saved row from the caller when provided to avoid
    // an extra read of the same row. The eligibility checks below either read
    // immutable fields or are re-guarded by atomic claim/update statements, so a
    // just-saved snapshot is safe.
    const reward =
      preloadedReward ??
      (await this.postingRewardRepository.findOne({ where: { address } }));
    if (!reward || reward.status === 'blocked_x_identity_conflict') {
      return;
    }
    if (options?.logStuckPayouts) {
      // Settle anything that broadcast on-chain but failed its DB confirmation
      // BEFORE logging what is still stuck, so the warnings only cover rows that
      // genuinely need a human (an in-progress sentinel from a hard crash).
      await this.reconcileConfirmationPending(reward);
      await this.logStuckPayouts(reward);
    }
    await this.payOnboardingIfEligible(reward);
    await this.payPendingLedger(address);
    await this.payStreakBonusesDue(address);
  }

  /**
   * Surface payouts stuck mid-flight (claimed sentinel left by a crash, or a
   * broadcast whose DB confirmation failed). They are intentionally
   * unclaimable — re-sending could double-pay — but they need chain-aware,
   * human reconciliation, so make every recheck shout about them.
   */
  private async logStuckPayouts(reward: ProfileXPostingReward): Promise<void> {
    if (
      reward.tx_hash ===
        ProfileXPostingRewardService.ONBOARDING_PAYOUT_IN_PROGRESS_TX_HASH &&
      reward.status !== 'paid'
    ) {
      this.logger.warn(
        `X onboarding payout for ${reward.address} is stuck in-progress and needs manual reconciliation`,
      );
    }
    const stuckLedgerCount = await this.postRewardLedgerRepository.count({
      where: {
        address: reward.address,
        tx_hash:
          ProfileXPostingRewardService.PERPOST_PAYOUT_IN_PROGRESS_TX_HASH,
        status: Not('paid'),
      } as any,
    });
    if (stuckLedgerCount > 0) {
      this.logger.warn(
        `${stuckLedgerCount} X per-post payout(s) for ${reward.address} are stuck in-progress and need manual reconciliation`,
      );
    }
    const stuckBonusCount = await this.streakBonusRewardRepository.count({
      where: {
        address: reward.address,
        tx_hash: ProfileXPostingRewardService.STREAK_PAYOUT_IN_PROGRESS_TX_HASH,
        status: Not('paid'),
      } as any,
    });
    if (stuckBonusCount > 0) {
      this.logger.warn(
        `${stuckBonusCount} X streak bonus payout(s) for ${reward.address} are stuck in-progress and need manual reconciliation`,
      );
    }
  }

  /**
   * Reconcile payouts that broadcast on-chain but whose DB confirmation write
   * failed (`payout_confirmation_pending` rows carrying the REAL tx hash). Each
   * hash is looked up on the middleware; a tx that is on-chain flips the row to
   * `paid` and clears the error. Rows still holding an in-progress sentinel
   * (a crash before the real hash was persisted) are skipped — they are not
   * confirmable from a hash we never recorded and are surfaced by
   * logStuckPayouts for manual review. Idempotent and double-spend-safe: it only
   * relabels an already-broadcast tx, it never sends.
   */
  private async reconcileConfirmationPending(
    reward: ProfileXPostingReward,
  ): Promise<void> {
    // Key the onboarding reconcile on the DURABLE signal (a not-paid row holding
    // a real broadcast hash) rather than on error === 'payout_confirmation_pending'.
    // The error field is cleared by prepareCheckCandidate and overwritten by the
    // next scan, but tx_hash + status persist — a real th_ hash on a non-paid row
    // can only be a broadcast-but-unconfirmed payout (the paid path sets the hash
    // and status='paid' together; the failed path leaves tx_hash null).
    if (
      (reward.status === 'pending' || reward.status === 'failed') &&
      this.isRealTxHash(reward.tx_hash) &&
      (await this.isTxOnChain(reward.tx_hash as string))
    ) {
      const result = await this.postingRewardRepository.update(
        { address: reward.address, tx_hash: reward.tx_hash } as any,
        { status: 'paid', error: null },
      );
      if (Number(result?.affected || 0) > 0) {
        reward.status = 'paid';
        reward.error = null;
        this.logger.log(
          `Reconciled onboarding payout for ${reward.address} from chain (${reward.tx_hash})`,
        );
      }
    }

    const pendingLedger = await this.postRewardLedgerRepository.find({
      where: {
        address: reward.address,
        status: In(['pending', 'failed']),
        error: 'payout_confirmation_pending',
      } as any,
      take: ProfileXPostingRewardService.LEDGER_BATCH_SIZE,
    });
    for (const row of pendingLedger) {
      if (
        this.isRealTxHash(row.tx_hash) &&
        (await this.isTxOnChain(row.tx_hash as string))
      ) {
        await this.postRewardLedgerRepository.update(
          { id: row.id, tx_hash: row.tx_hash } as any,
          { status: 'paid', error: null },
        );
        this.logger.log(
          `Reconciled per-post payout ${row.tweet_id} for ${row.address} from chain (${row.tx_hash})`,
        );
      }
    }

    const pendingBonus = await this.streakBonusRewardRepository.find({
      where: {
        address: reward.address,
        status: In(['pending', 'failed']),
        error: 'payout_confirmation_pending',
      } as any,
      take: ProfileXPostingRewardService.STREAK_BONUS_BATCH_SIZE,
    });
    for (const row of pendingBonus) {
      if (
        this.isRealTxHash(row.tx_hash) &&
        (await this.isTxOnChain(row.tx_hash as string))
      ) {
        await this.streakBonusRewardRepository.update(
          { id: row.id, tx_hash: row.tx_hash } as any,
          { status: 'paid', error: null },
        );
        this.logger.log(
          `Reconciled streak bonus (ending ${row.streak_completed_day}) for ${row.address} from chain (${row.tx_hash})`,
        );
      }
    }
  }

  /**
   * A real broadcast tx hash (th_...), as opposed to an in-progress sentinel or
   * the `'broadcasted'` placeholder used when the SDK returned no hash.
   */
  private isRealTxHash(txHash: string | null | undefined): boolean {
    return typeof txHash === 'string' && txHash.startsWith('th_');
  }

  /**
   * Resolve the broadcast tx hash from a `spend()` rejection, returning a hash
   * ONLY when the transaction was actually submitted on-chain — so the caller
   * records it as broadcast (`payout_confirmation_pending`, unclaimable,
   * reconciled from chain) instead of re-sending it (which would double-pay).
   * Returns null for rejections that did NOT broadcast (build / signing /
   * verification / node-rejection), which are genuinely safe to retry.
   *
   * The SDK broadcasts in `postTransaction` and THEN polls for mining
   * (`waitMined` defaults to true). Two cases:
   *  - `TxTimedOutError` is thrown ONLY by `poll()`, which runs AFTER a
   *    successful broadcast — so the tx is definitely in the mempool and will
   *    mine. The real hash is embedded in the message (with a `buildTxHash`
   *    fallback). Trusted without a chain lookup.
   *  - Any OTHER rejection that still carries the signed `rawTx` is ambiguous: it
   *    could be a pre-broadcast sign/verify/node-reject, or a post-broadcast
   *    transient poll/network error. Derive the candidate hash and ASK THE CHAIN —
   *    a tx the node accepted is visible on the middleware; a never-broadcast tx
   *    is not. Only a positive on-chain hit is treated as broadcast, so an
   *    ordinary send failure still retries while a tx that genuinely landed is
   *    never re-sent.
   */
  private async resolveBroadcastedTxHash(
    error: unknown,
  ): Promise<string | null> {
    const candidate = error as {
      name?: unknown;
      message?: unknown;
      rawTx?: unknown;
    };
    const isTimeout = candidate?.name === 'TxTimedOutError';
    let hash: string | null = null;
    // The timeout message embeds the real hash ("... transaction hash: th_...").
    if (isTimeout && typeof candidate.message === 'string') {
      hash = candidate.message.match(/th_[1-9A-HJ-NP-Za-km-z]+/)?.[0] ?? null;
    }
    // Otherwise (or if the message had none) derive it from the signed tx the
    // SDK attaches to the error.
    if (
      !this.isRealTxHash(hash) &&
      typeof candidate?.rawTx === 'string' &&
      candidate.rawTx
    ) {
      try {
        hash = buildTxHash(candidate.rawTx as `tx_${string}`);
      } catch {
        hash = null;
      }
    }
    if (!this.isRealTxHash(hash)) {
      return null;
    }
    // A poll timeout is proof of broadcast; trust it without a lookup.
    if (isTimeout) {
      return hash;
    }
    // Ambiguous failure: only treat it as broadcast (and therefore unclaimable)
    // when the chain actually has the tx. A not-yet-broadcast failure is not on
    // chain → null → the caller retries it safely.
    return (await this.isTxOnChain(hash as string)) ? hash : null;
  }

  /**
   * True when the middleware knows the transaction (i.e. it is on-chain). Any
   * error (404 not-yet-seen / network / timeout) is treated as "not confirmed
   * yet" so reconciliation simply retries on the next recovery pass.
   */
  private async isTxOnChain(txHash: string): Promise<boolean> {
    try {
      const tx = await fetchJson(
        `${ACTIVE_NETWORK.middlewareUrl}/v3/txs/${encodeURIComponent(txHash)}`,
      );
      return !!tx;
    } catch {
      return false;
    }
  }

  private async payOnboardingIfEligible(
    reward: ProfileXPostingReward,
  ): Promise<void> {
    if (!PROFILE_X_ONBOARDING_REWARD_ENABLED) {
      return;
    }
    if (
      reward.status === 'paid' ||
      reward.status === 'blocked_x_identity_conflict'
    ) {
      return;
    }
    const threshold = isValidPositiveInteger(PROFILE_X_ONBOARDING_THRESHOLD)
      ? PROFILE_X_ONBOARDING_THRESHOLD
      : 1;
    if (Number(reward.qualified_posts_count || 0) < threshold) {
      return;
    }
    if (!PROFILE_X_ONBOARDING_REWARD_PRIVATE_KEY) {
      this.logger.warn(
        'Skipping onboarding reward, private key not configured',
      );
      return;
    }
    if (!isValidAeAmount(PROFILE_X_ONBOARDING_REWARD_AMOUNT_AE)) {
      this.logger.warn('Skipping onboarding reward, invalid amount');
      return;
    }
    const amountAettos = getRewardAmountAettos({
      amountAe: PROFILE_X_ONBOARDING_REWARD_AMOUNT_AE,
      logger: this.logger,
      rewardLabel: 'X onboarding reward',
    });
    if (!amountAettos) {
      return;
    }

    // Respect the failure backoff: a failed send schedules next_retry_at, so do
    // not re-send until it elapses. The atomic claim below still guards against
    // concurrent double-claims; this only throttles the per-recheck retry cadence
    // (the ledger/streak payouts back off the same way).
    if (
      reward.next_retry_at &&
      new Date(reward.next_retry_at).getTime() > Date.now()
    ) {
      return;
    }

    const claimed = await this.claimOnboardingPayoutAttempt(reward.address);
    if (!claimed) {
      return;
    }

    let broadcastHash: string | null = null;
    try {
      await this.profileSpendQueueService.enqueueSpend(
        PROFILE_X_ONBOARDING_REWARD_PRIVATE_KEY,
        async () => {
          const rewardAccount = this.profileSpendQueueService.getRewardAccount(
            PROFILE_X_ONBOARDING_REWARD_PRIVATE_KEY,
            'PROFILE_X_ONBOARDING_REWARD_PRIVATE_KEY',
          );
          const spendResult = await this.aeSdkService.sdk.spend(
            amountAettos,
            reward.address as `ak_${string}`,
            { onAccount: rewardAccount },
          );
          broadcastHash = spendResult.hash || 'broadcasted';
          await this.postingRewardRepository.update(
            { address: reward.address },
            {
              tx_hash: spendResult.hash || null,
              status: 'paid',
              error: null,
              last_attempt_at: new Date(),
            },
          );
          this.logger.log(
            `Sent ${PROFILE_X_ONBOARDING_REWARD_AMOUNT_AE} AE X onboarding reward to ${reward.address}`,
          );
        },
      );
    } catch (error) {
      const broadcastedHash =
        broadcastHash ?? (await this.resolveBroadcastedTxHash(error));
      if (broadcastedHash) {
        // Broadcasted but the awaited spend/DB step failed — either the final DB
        // write threw, or the post-broadcast mining poll timed out. Persist the
        // REAL tx hash (still non-null → row stays unclaimable, no double-spend)
        // so the confirmation finalizer can later settle it from the chain
        // instead of re-sending it.
        await this.postingRewardRepository.update(
          { address: reward.address },
          {
            tx_hash: broadcastedHash,
            error: 'payout_confirmation_pending',
            last_attempt_at: new Date(),
          },
        );
        this.logger.error(
          `Onboarding reward broadcasted for ${reward.address} but could not be confirmed`,
          error instanceof Error ? error.stack : String(error),
        );
        return;
      }
      const retryCount = Number(reward.retry_count || 0) + 1;
      await this.postingRewardRepository.update(
        { address: reward.address },
        {
          tx_hash: null,
          status: 'failed',
          error: 'payout_send_failed',
          retry_count: retryCount,
          next_retry_at: new Date(
            Date.now() + this.getRetryDelaySeconds(retryCount) * 1000,
          ),
          last_attempt_at: new Date(),
        },
      );
      this.logger.warn(
        `Failed to send X onboarding reward to ${reward.address}, scheduled retry`,
      );
    }
  }

  private async claimOnboardingPayoutAttempt(
    address: string,
  ): Promise<boolean> {
    const result = await this.postingRewardRepository.update(
      {
        address,
        tx_hash: IsNull(),
        status: In(['pending', 'failed']),
      } as any,
      {
        tx_hash:
          ProfileXPostingRewardService.ONBOARDING_PAYOUT_IN_PROGRESS_TX_HASH,
        error: null,
        last_attempt_at: new Date(),
      },
    );
    return Number(result?.affected || 0) > 0;
  }

  private async payPendingLedger(address: string): Promise<void> {
    if (!PROFILE_X_PERPOST_REWARD_ENABLED) {
      return;
    }
    if (!PROFILE_X_PERPOST_REWARD_PRIVATE_KEY) {
      this.logger.warn('Skipping per-post reward, private key not configured');
      return;
    }
    // Drain the full due backlog in one pass (bounded) instead of leaving rows
    // beyond a single batch stranded until the next daily-capped recheck. Each
    // due row transitions to paid / failed-with-future-retry / skipped, so it
    // drops out of the next fetch; the no-progress break guards against rows we
    // cannot claim (e.g. an in-progress sentinel) re-appearing forever.
    for (
      let run = 0;
      run < ProfileXPostingRewardService.MAX_LEDGER_DRAIN_RUNS;
      run += 1
    ) {
      const now = new Date();
      const dueRows = await this.postRewardLedgerRepository.find({
        where: [
          {
            address,
            status: In(['pending', 'failed']),
            next_retry_at: IsNull(),
          },
          {
            address,
            status: In(['pending', 'failed']),
            next_retry_at: LessThanOrEqual(now),
          },
        ],
        take: ProfileXPostingRewardService.LEDGER_BATCH_SIZE,
      });
      if (dueRows.length === 0) {
        return;
      }
      let progressed = 0;
      for (const row of dueRows) {
        if (await this.payLedgerRow(row)) {
          progressed += 1;
        }
      }
      if (
        progressed === 0 ||
        dueRows.length < ProfileXPostingRewardService.LEDGER_BATCH_SIZE
      ) {
        return;
      }
    }
  }

  /**
   * Attempt to settle a single ledger row. Returns true when the row's state
   * advanced (paid / failed / skipped), false when it could not be claimed (so
   * the drain loop can detect a lack of progress and stop).
   */
  private async payLedgerRow(row: ProfileXPostRewardLedger): Promise<boolean> {
    const amountAettos = row.amount_aettos;
    if (!amountAettos || !/^\d+$/.test(amountAettos) || amountAettos === '0') {
      await this.postRewardLedgerRepository.update(
        { id: row.id },
        { status: 'skipped', error: 'invalid_amount', next_retry_at: null },
      );
      return true;
    }
    const claimed = await this.claimLedgerPayoutAttempt(row.id);
    if (!claimed) {
      return false;
    }

    let broadcastHash: string | null = null;
    try {
      await this.profileSpendQueueService.enqueueSpend(
        PROFILE_X_PERPOST_REWARD_PRIVATE_KEY,
        async () => {
          const rewardAccount = this.profileSpendQueueService.getRewardAccount(
            PROFILE_X_PERPOST_REWARD_PRIVATE_KEY,
            'PROFILE_X_PERPOST_REWARD_PRIVATE_KEY',
          );
          const spendResult = await this.aeSdkService.sdk.spend(
            amountAettos,
            row.address as `ak_${string}`,
            { onAccount: rewardAccount },
          );
          broadcastHash = spendResult.hash || 'broadcasted';
          await this.postRewardLedgerRepository.update(
            { id: row.id },
            {
              tx_hash: spendResult.hash || null,
              status: 'paid',
              error: null,
              next_retry_at: null,
            },
          );
        },
      );
    } catch (error) {
      const broadcastedHash =
        broadcastHash ?? (await this.resolveBroadcastedTxHash(error));
      if (broadcastedHash) {
        // Broadcasted but the awaited spend/DB step failed (DB write error, or a
        // post-broadcast mining-poll timeout). Persist the REAL tx hash (still
        // non-null → row stays unclaimable so we cannot double-spend); the
        // confirmation finalizer reconciles `payout_confirmation_pending` from
        // the chain.
        await this.postRewardLedgerRepository.update(
          { id: row.id },
          {
            tx_hash: broadcastedHash,
            error: 'payout_confirmation_pending',
            next_retry_at: null,
          },
        );
        this.logger.error(
          `Per-post reward broadcasted for ${row.address} tweet ${row.tweet_id} but could not be confirmed`,
          error instanceof Error ? error.stack : String(error),
        );
        return true;
      }
      const retryCount = Number(row.retry_count || 0) + 1;
      await this.postRewardLedgerRepository.update(
        { id: row.id },
        {
          tx_hash: null,
          status: 'failed',
          error: 'payout_send_failed',
          retry_count: retryCount,
          next_retry_at: new Date(
            Date.now() + this.getRetryDelaySeconds(retryCount) * 1000,
          ),
        },
      );
      this.logger.warn(
        `Failed to send per-post reward to ${row.address} tweet ${row.tweet_id}, scheduled retry`,
      );
    }
    return true;
  }

  private async claimLedgerPayoutAttempt(id: string): Promise<boolean> {
    const result = await this.postRewardLedgerRepository.update(
      {
        id,
        tx_hash: IsNull(),
        status: In(['pending', 'failed']),
      } as any,
      {
        tx_hash:
          ProfileXPostingRewardService.PERPOST_PAYOUT_IN_PROGRESS_TX_HASH,
        error: null,
        next_retry_at: null,
      },
    );
    return Number(result?.affected || 0) > 0;
  }

  /**
   * Settle all due streak-bonus completion rows for the address. Mirrors the
   * per-post ledger flow: atomic claim → spend → paid / failed-with-backoff,
   * with the broadcast-hash guard so a spend that broadcast but whose DB
   * confirmation failed stays unclaimable instead of being re-sent (the bug
   * class the old one-time flow had).
   */
  private async payStreakBonusesDue(address: string): Promise<void> {
    if (!PROFILE_X_REWARD_STREAK_BONUS_ENABLED) {
      return;
    }
    if (!PROFILE_X_REWARD_STREAK_BONUS_PRIVATE_KEY) {
      this.logger.warn('Skipping streak bonus, private key not configured');
      return;
    }
    const now = new Date();
    const dueRows = await this.streakBonusRewardRepository.find({
      where: [
        {
          address,
          status: In(['pending', 'failed']),
          next_retry_at: IsNull(),
        },
        {
          address,
          status: In(['pending', 'failed']),
          next_retry_at: LessThanOrEqual(now),
        },
      ],
      take: ProfileXPostingRewardService.STREAK_BONUS_BATCH_SIZE,
    });
    for (const row of dueRows) {
      await this.payStreakBonusRow(row);
    }
  }

  private async payStreakBonusRow(
    row: ProfileXStreakBonusReward,
  ): Promise<void> {
    const amountAettos = row.amount_aettos;
    if (!amountAettos || !/^\d+$/.test(amountAettos) || amountAettos === '0') {
      await this.streakBonusRewardRepository.update(
        { id: row.id },
        { status: 'skipped', error: 'invalid_amount', next_retry_at: null },
      );
      return;
    }
    const claimed = await this.claimStreakBonusPayoutAttempt(row.id);
    if (!claimed) {
      return;
    }

    let broadcastHash: string | null = null;
    try {
      await this.profileSpendQueueService.enqueueSpend(
        PROFILE_X_REWARD_STREAK_BONUS_PRIVATE_KEY,
        async () => {
          const rewardAccount = this.profileSpendQueueService.getRewardAccount(
            PROFILE_X_REWARD_STREAK_BONUS_PRIVATE_KEY,
            'PROFILE_X_REWARD_STREAK_BONUS_PRIVATE_KEY',
          );
          const spendResult = await this.aeSdkService.sdk.spend(
            amountAettos,
            row.address as `ak_${string}`,
            { onAccount: rewardAccount },
          );
          broadcastHash = spendResult.hash || 'broadcasted';
          await this.streakBonusRewardRepository.update(
            { id: row.id },
            {
              tx_hash: spendResult.hash || null,
              status: 'paid',
              error: null,
              next_retry_at: null,
            },
          );
          this.logger.log(
            `Sent X streak bonus (streak ending ${row.streak_completed_day}) to ${row.address}`,
          );
        },
      );
    } catch (error) {
      const broadcastedHash =
        broadcastHash ?? (await this.resolveBroadcastedTxHash(error));
      if (broadcastedHash) {
        // Broadcasted but the awaited spend/DB step failed (DB write error, or a
        // post-broadcast mining-poll timeout). Persist the REAL tx hash (still
        // non-null → row stays unclaimable so we cannot double-pay); the
        // confirmation finalizer reconciles `payout_confirmation_pending` from
        // the chain.
        await this.streakBonusRewardRepository.update(
          { id: row.id },
          {
            tx_hash: broadcastedHash,
            error: 'payout_confirmation_pending',
            next_retry_at: null,
          },
        );
        this.logger.error(
          `Streak bonus broadcasted for ${row.address} (streak ending ${row.streak_completed_day}) but could not be confirmed`,
          error instanceof Error ? error.stack : String(error),
        );
        return;
      }
      const retryCount = Number(row.retry_count || 0) + 1;
      await this.streakBonusRewardRepository.update(
        { id: row.id },
        {
          tx_hash: null,
          status: 'failed',
          error: 'payout_send_failed',
          retry_count: retryCount,
          next_retry_at: new Date(
            Date.now() + this.getRetryDelaySeconds(retryCount) * 1000,
          ),
        },
      );
      this.logger.warn(
        `Failed to send X streak bonus to ${row.address} (streak ending ${row.streak_completed_day}), scheduled retry`,
      );
    }
  }

  private async claimStreakBonusPayoutAttempt(id: number): Promise<boolean> {
    const result = await this.streakBonusRewardRepository.update(
      {
        id,
        tx_hash: IsNull(),
        status: In(['pending', 'failed']),
      } as any,
      {
        tx_hash: ProfileXPostingRewardService.STREAK_PAYOUT_IN_PROGRESS_TX_HASH,
        error: null,
        next_retry_at: null,
      },
    );
    return Number(result?.affected || 0) > 0;
  }

  private getRetryDelaySeconds(retryCount: number): number {
    const base = Math.max(PROFILE_X_POSTING_REWARD_RETRY_BASE_SECONDS || 30, 1);
    const max = Math.max(
      PROFILE_X_POSTING_REWARD_RETRY_MAX_SECONDS || 3600,
      base,
    );
    const exponent = Math.max(retryCount - 1, 0);
    const delay = base * 2 ** Math.min(exponent, 10);
    return Math.min(delay, max);
  }

  /* ------------------------------------------------------------------ */
  /* Public status payload                                               */
  /* ------------------------------------------------------------------ */

  private toPublicRewardStatus(
    reward: ProfileXPostingReward | null | undefined,
    ledgerTotals: { count: number; aettos: string } | null,
    streakBonus?: { status: PublicPaymentStatus; paidCount: number },
  ): PublicPostingRewardStatusPayload {
    const onboardingThreshold = isValidPositiveInteger(
      PROFILE_X_ONBOARDING_THRESHOLD,
    )
      ? PROFILE_X_ONBOARDING_THRESHOLD
      : 1;
    const streakRequired = isValidPositiveInteger(
      PROFILE_X_REWARD_STREAK_LENGTH,
    )
      ? PROFILE_X_REWARD_STREAK_LENGTH
      : 10;
    if (!reward) {
      return {
        status: 'not_started',
        x_username: null,
        x_user_id: null,
        referral_code: null,
        referral_link: null,
        onboarding_status: 'not_started',
        onboarding_threshold: onboardingThreshold,
        qualified_posts_count: 0,
        remaining_to_goal: onboardingThreshold,
        per_post_total_paid_count: 0,
        per_post_total_paid_aettos: '0',
        follower_count: null,
        min_followers_required: PROFILE_X_REWARD_MIN_FOLLOWERS,
        follower_tier_index: null,
        tier_amount_ae: null,
        current_streak_days: 0,
        streak_required: streakRequired,
        streak_bonus_status: 'not_started',
        streak_bonus_paid_count: 0,
        next_check_allowed_at: null,
        tx_hash: null,
        error: null,
      };
    }
    const qualifiedCount = Number(reward.qualified_posts_count || 0);
    const onboardingStatus = this.toOnboardingStatus(reward);
    const tier = resolveFollowerTier(
      PROFILE_X_FOLLOWER_TIERS || [],
      Number(reward.follower_count || 0),
    );
    return {
      status: onboardingStatus === 'paid' ? 'paid' : this.toScanStatus(reward),
      x_username: reward.x_username,
      x_user_id: reward.x_user_id,
      referral_code: reward.referral_code,
      referral_link: reward.referral_code
        ? this.buildReferralLink(reward.referral_code)
        : null,
      onboarding_status: onboardingStatus,
      onboarding_threshold: onboardingThreshold,
      qualified_posts_count: qualifiedCount,
      remaining_to_goal: Math.max(onboardingThreshold - qualifiedCount, 0),
      per_post_total_paid_count: ledgerTotals?.count || 0,
      per_post_total_paid_aettos: ledgerTotals?.aettos || '0',
      follower_count: reward.follower_count ?? null,
      min_followers_required: PROFILE_X_REWARD_MIN_FOLLOWERS,
      follower_tier_index: reward.follower_tier_index ?? null,
      tier_amount_ae: tier ? tier.amountAe : null,
      current_streak_days: Number(reward.current_streak_days || 0),
      streak_required: streakRequired,
      streak_bonus_status: streakBonus?.status ?? 'not_started',
      streak_bonus_paid_count: streakBonus?.paidCount ?? 0,
      next_check_allowed_at: this.computeNextCheckAllowedAt(
        reward.last_x_api_scan_at || null,
      ),
      tx_hash: this.sanitizeTxHash(reward.tx_hash),
      error: this.toPublicError(reward),
    };
  }

  private toOnboardingStatus(
    reward: ProfileXPostingReward,
  ): PublicPaymentStatus {
    if (reward.status === 'paid') {
      return 'paid';
    }
    if (
      reward.tx_hash ===
      ProfileXPostingRewardService.ONBOARDING_PAYOUT_IN_PROGRESS_TX_HASH
    ) {
      return 'pending';
    }
    if (reward.status === 'failed') {
      return 'failed';
    }
    if (Number(reward.qualified_posts_count || 0) > 0) {
      return 'pending';
    }
    return 'not_started';
  }

  private toScanStatus(
    reward: ProfileXPostingReward,
  ): PublicPostingRewardStatus {
    if (reward.status === 'blocked_x_identity_conflict') {
      return 'failed';
    }
    if (reward.status === 'failed') {
      return 'failed';
    }
    return 'pending';
  }

  private sanitizeTxHash(txHash: string | null): string | null {
    if (
      txHash ===
        ProfileXPostingRewardService.ONBOARDING_PAYOUT_IN_PROGRESS_TX_HASH ||
      txHash ===
        ProfileXPostingRewardService.PERPOST_PAYOUT_IN_PROGRESS_TX_HASH ||
      txHash === ProfileXPostingRewardService.STREAK_PAYOUT_IN_PROGRESS_TX_HASH
    ) {
      return null;
    }
    return txHash;
  }

  private toPublicError(reward: ProfileXPostingReward): string | null {
    if (reward.status === 'paid') {
      return null;
    }
    if (
      reward.tx_hash ===
      ProfileXPostingRewardService.ONBOARDING_PAYOUT_IN_PROGRESS_TX_HASH
    ) {
      return 'Reward payout is being finalized.';
    }
    switch (reward.error) {
      case 'missing_x_username':
        return 'Link your X account to use posting rewards.';
      case 'x_user_lookup_failed':
        return 'The linked X account could not be resolved. Reconnect it and try again.';
      case 'x_user_lookup_blocked':
        return 'The linked X account could not be resolved repeatedly. Re-link your X account to continue.';
      case 'below_min_followers':
        return `Your X account needs at least ${PROFILE_X_REWARD_MIN_FOLLOWERS} followers to earn posting rewards.`;
      case 'follower_count_unavailable':
        return 'Your X follower count could not be read. Try again later.';
      case 'x_posts_fetch_failed':
        return 'X posts could not be checked right now. Try again later.';
      case 'x_posts_scan_truncated':
        return 'Your most recent posts were checked; posts beyond the per-check scan limit are not counted.';
      case 'post_fetch_disabled':
        return 'Posting reward checks are temporarily unavailable.';
      case 'missing_keywords':
      case 'invalid_address':
        return 'Posting rewards are temporarily unavailable.';
      case 'x_identity_already_rewarded':
        return 'This X account is already being used for another reward.';
      case 'payout_send_failed':
        return 'Reward payout could not be completed right now. Try again later.';
      case 'payout_confirmation_pending':
        return 'Reward payout is being finalized.';
      default:
        return reward.error ? 'Posting reward is pending.' : null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Matching helpers                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * A qualifying keyword post must contain AT LEAST ONE configured keyword
   * (e.g. `superhero.com` or the `superhero_chain` mention), either in the
   * tweet text or in one of its URLs.
   */
  private matchesKeyword(post: XTweetItem): boolean {
    const normalizedText = (post.text || '').toLowerCase();
    const normalizedUrls = (post.urls || [])
      .map((url) => (url || '').toLowerCase())
      .filter(Boolean);
    return PROFILE_X_POSTING_REWARD_KEYWORDS.some((keyword) => {
      if (normalizedText.includes(keyword)) {
        return true;
      }
      return normalizedUrls.some((url) => url.includes(keyword));
    });
  }

  private matchesReferral(
    post: XTweetItem,
    referralCode: string | null,
  ): boolean {
    if (!referralCode) {
      return false;
    }
    return matchesReferralCode({
      candidateUrls: post.urls,
      referralCode,
      referralHost: extractReferralHost(PROFILE_X_REFERRAL_LINK_BASE_URL),
    });
  }

  /* ------------------------------------------------------------------ */
  /* X API reads                                                         */
  /* ------------------------------------------------------------------ */

  private async resolveXUserProfile(
    knownUserId: string | null,
    username: string,
  ): Promise<XUserProfile | null> {
    if (knownUserId) {
      const byId = await this.fetchXUserById(knownUserId);
      if (byId.profile) {
        return byId.profile;
      }
      // Only spend a SECOND (paid) lookup when the id is definitively gone
      // (404 / resolved-to-nothing) — e.g. the handle changed or the id rotated.
      // On a transient failure (429 / 5xx / network / no token) abort having
      // spent a single call; the next daily-capped scan retries, instead of
      // burning two lookups per scan during an X outage.
      if (!byId.notFound) {
        return null;
      }
    }
    return this.fetchXUserProfileByUsername(username);
  }

  private async fetchXUserProfileByUsername(
    username: string,
  ): Promise<XUserProfile | null> {
    const token = await this.getXAppAccessToken();
    if (!token) {
      return null;
    }
    try {
      const { response, body, baseUrl } = await this.fetchXReadWithAuthFallback(
        `/2/users/by/username/${encodeURIComponent(
          username,
        )}?user.fields=id,username,public_metrics`,
        token,
      );
      if (!response.ok || !(body as any)?.data?.id) {
        this.logger.warn('X username lookup failed for posting reward', {
          username,
          base_url: baseUrl,
          status: response.status,
          detail: (body as any)?.detail || (body as any)?.title,
        });
        return null;
      }
      return this.toXUserProfile((body as any).data, username);
    } catch (error) {
      this.logger.warn(
        `Failed to fetch X user profile for @${username}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private async fetchXUserById(
    userId: string,
  ): Promise<{ profile: XUserProfile | null; notFound: boolean }> {
    const token = await this.getXAppAccessToken();
    if (!token) {
      return { profile: null, notFound: false };
    }
    try {
      const { response, body, baseUrl } = await this.fetchXReadWithAuthFallback(
        `/2/users/${encodeURIComponent(
          userId,
        )}?user.fields=id,username,public_metrics`,
        token,
      );
      if (response.ok && (body as any)?.data?.id) {
        return {
          profile: this.toXUserProfile((body as any).data, null),
          notFound: false,
        };
      }
      this.logger.warn('X user id lookup failed for posting reward', {
        user_id: userId,
        base_url: baseUrl,
        status: response.status,
        detail: (body as any)?.detail || (body as any)?.title,
      });
      // A 404, or a 200 whose payload resolved to no user, both mean the id is
      // gone for good → worth a username fallback. Other non-OK statuses
      // (429 / 5xx) are transient → signal "not notFound" so the caller does
      // NOT spend a second lookup.
      return {
        profile: null,
        notFound: response.status === 404 || response.ok,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to fetch X user by id ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { profile: null, notFound: false };
    }
  }

  private toXUserProfile(
    data: any,
    fallbackUsername: string | null,
  ): XUserProfile {
    const followers = Number(data?.public_metrics?.followers_count);
    return {
      id: String(data?.id),
      username: String(data?.username || fallbackUsername || ''),
      followersCount: Number.isFinite(followers) ? followers : null,
    };
  }

  private async fetchUserPostsSince(
    userId: string,
    sinceId?: string | null,
    startTime?: Date | null,
  ): Promise<XPostFetchResult | null> {
    const token = await this.getXAppAccessToken();
    if (!token) {
      return null;
    }
    let pageCount = 0;
    let nextToken: string | null = null;
    let newestTweetId: string | null = null;
    const postsById = new Map<string, XTweetItem>();

    while (true) {
      pageCount += 1;
      if (
        pageCount > ProfileXPostingRewardService.DEFAULT_MAX_TWEET_PAGE_COUNT
      ) {
        this.logger.warn(
          `Reached X posting reward pagination cap for user ${userId}; older posts beyond the cap are not counted`,
        );
        return {
          posts: Array.from(postsById.values()),
          newestTweetId,
          truncated: true,
        };
      }
      const params = new URLSearchParams({
        max_results: '100',
        'tweet.fields': 'created_at,entities',
        exclude: 'retweets,replies',
      });
      if (sinceId) {
        params.set('since_id', sinceId);
      } else if (startTime) {
        params.set('start_time', startTime.toISOString());
      }
      if (nextToken) {
        params.set('pagination_token', nextToken);
      }
      try {
        const { response, body, baseUrl } =
          await this.fetchXReadWithAuthFallback(
            `/2/users/${encodeURIComponent(userId)}/tweets?${params.toString()}`,
            token,
          );
        if (!response.ok) {
          this.logger.warn('X tweets fetch failed for posting reward', {
            user_id: userId,
            base_url: baseUrl,
            status: response.status,
            detail: (body as any)?.detail || (body as any)?.title,
          });
          return null;
        }
        const pagePosts = Array.isArray((body as any)?.data)
          ? (body as any).data
              .map((item: any) => ({
                id: String(item?.id || ''),
                text: String(item?.text || ''),
                urls: this.extractCandidateUrls(item),
                createdAt: item?.created_at
                  ? new Date(String(item.created_at))
                  : null,
              }))
              .filter((item: XTweetItem) => !!item.id)
          : [];
        for (const post of pagePosts) {
          postsById.set(post.id, post);
          newestTweetId = this.pickNewestTweetId(newestTweetId, post.id);
        }
        nextToken = (body as any)?.meta?.next_token
          ? String((body as any).meta.next_token)
          : null;
        const newestFromMeta = (body as any)?.meta?.newest_id
          ? String((body as any).meta.newest_id)
          : null;
        if (!nextToken) {
          newestTweetId = this.pickNewestTweetId(newestTweetId, newestFromMeta);
        }
        if (!nextToken) {
          return {
            posts: Array.from(postsById.values()),
            newestTweetId,
            truncated: false,
          };
        }
      } catch (error) {
        this.logger.warn(
          `Failed to fetch X posts for user ${userId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return null;
      }
    }
  }

  private async findConflictingReward(
    rewardRepo: Repository<ProfileXPostingReward>,
    address: string,
    xUserId: string | null,
    xUsername: string | null,
  ): Promise<ProfileXPostingReward | null> {
    const activeStatuses: Array<ProfileXPostingReward['status']> = [
      'pending',
      'paid',
    ];
    if (xUserId) {
      const byUserId = await rewardRepo.findOne({
        where: {
          x_user_id: xUserId,
          address: Not(address),
          status: In(activeStatuses),
        },
      });
      if (byUserId) {
        return byUserId;
      }
    }
    if (xUsername) {
      const byUsername = await rewardRepo.findOne({
        where: {
          x_username: xUsername,
          address: Not(address),
          status: In(activeStatuses),
        },
      });
      if (byUsername) {
        return byUsername;
      }
    }
    return null;
  }

  private pickNewestTweetId(
    current: string | null,
    candidate: string | null,
  ): string | null {
    if (!candidate) {
      return current;
    }
    if (!current) {
      return candidate;
    }
    try {
      return BigInt(candidate) > BigInt(current) ? candidate : current;
    } catch {
      return candidate > current ? candidate : current;
    }
  }

  private extractCandidateUrls(tweetItem: any): string[] {
    const entityUrls = Array.isArray(tweetItem?.entities?.urls)
      ? tweetItem.entities.urls
      : [];
    const results = new Set<string>();
    for (const item of entityUrls) {
      const candidates = [
        item?.expanded_url,
        item?.display_url,
        item?.unwound_url,
        item?.url,
      ];
      for (const candidate of candidates) {
        const value = String(candidate || '').trim();
        if (value) {
          results.add(value);
        }
      }
    }
    return Array.from(results.values());
  }

  private microTimeToDate(value?: string): Date | null {
    return microTimeToDate(value);
  }

  private isXIdentityUniqueConstraintError(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }
    const payload = (error as any)?.driverError || {};
    const code = payload.code?.toString?.() || '';
    const constraint = payload.constraint?.toString?.() || '';
    return (
      code === '23505' &&
      constraint.includes('ux_profile_x_posting_rewards_x_user_id')
    );
  }

  private isReferralCodeUniqueConstraintError(error: unknown): boolean {
    const driverError = (error as any)?.driverError || error;
    const code = String(driverError?.code || '');
    const constraint = String(driverError?.constraint || '').toLowerCase();
    const detail = String(
      driverError?.detail || driverError?.message || '',
    ).toLowerCase();
    return (
      code === '23505' &&
      (constraint.includes('referral_code') || detail.includes('referral_code'))
    );
  }

  private async getXAppAccessToken(): Promise<string | null> {
    const appKey = X_API_KEY || X_CLIENT_ID;
    const appSecret = X_API_KEY_SECRET || X_CLIENT_SECRET;
    const timeoutMs = isValidPositiveInteger(
      PROFILE_X_POSTING_REWARD_FETCH_TIMEOUT_MS,
    )
      ? PROFILE_X_POSTING_REWARD_FETCH_TIMEOUT_MS
      : 5000;
    return this.profileXApiClientService.getXAppAccessToken({
      appKey,
      appSecret,
      tokenEndpoints: [
        {
          baseUrl: 'https://api.x.com',
          url: 'https://api.x.com/oauth2/token',
          body: new URLSearchParams({ grant_type: 'client_credentials' }),
        },
        {
          baseUrl: 'https://api.twitter.com',
          url: 'https://api.twitter.com/oauth2/token',
          body: new URLSearchParams({ grant_type: 'client_credentials' }),
        },
      ],
      logger: this.logger,
      missingCredentialsMessage:
        'Skipping X posting reward, app token credentials are required',
      tokenFailureMessage:
        'Failed to obtain X app access token for post checks',
      tokenErrorPrefix: 'Failed to obtain X app access token for post checks',
      timeoutMs,
    });
  }

  private async fetchXReadWithAuthFallback(
    pathAndQuery: string,
    bearerToken: string,
  ): Promise<{ response: Response; body: any; baseUrl: string }> {
    const timeoutMs = isValidPositiveInteger(
      PROFILE_X_POSTING_REWARD_FETCH_TIMEOUT_MS,
    )
      ? PROFILE_X_POSTING_REWARD_FETCH_TIMEOUT_MS
      : 5000;
    return this.profileXApiClientService.fetchXReadWithAuthFallback(
      pathAndQuery,
      bearerToken,
      timeoutMs,
      'profile-x-read',
    );
  }

  private assertValidAddress(address: string): void {
    if (!ProfileXPostingRewardService.ADDRESS_REGEX.test(address || '')) {
      throw new BadRequestException('Invalid address');
    }
  }
}

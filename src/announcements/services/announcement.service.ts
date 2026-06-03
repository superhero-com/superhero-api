import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { Announcement } from '../entities/announcement.entity';
import { AnnouncementTarget } from '../entities/announcement-target.entity';

/**
 * Two-phase claim/complete lifecycle so a crash between claim and dispatch
 * completion doesn't permanently strand a row. `claimed_at` is the in-flight
 * marker; `processed_at` is the finished marker; `releaseStuck()` re-queues
 * orphans that stalled too long with claimed_at set.
 */
export interface CompletionResult {
  recipientCount: number;
  deliveredCount: number;
  optedOutCount: number;
  /** Recipients with no registered channel for this notification type. */
  noChannelCount: number;
  failedCount: number;
  error?: string;
}

@Injectable()
export class AnnouncementService {
  private readonly logger = new Logger(AnnouncementService.name);

  constructor(
    @InjectRepository(Announcement)
    private readonly announcementRepository: Repository<Announcement>,
    @InjectRepository(AnnouncementTarget)
    private readonly targetRepository: Repository<AnnouncementTarget>,
  ) {}

  /**
   * Atomically claim the next due, unprocessed, unclaimed announcement and
   * stamp `claimed_at` AND a fresh `claim_token` UUID. `FOR UPDATE SKIP LOCKED`
   * keeps replicas from picking the same row. The token is the ownership
   * identifier the heartbeat / mark-completed / release-claim methods check
   * to detect peer takeover.
   */
  async claimNextDue(): Promise<Announcement | null> {
    const token = randomUUID();
    const result = await this.announcementRepository
      .createQueryBuilder()
      .update(Announcement)
      .set({ claimed_at: () => 'now()', claim_token: token })
      .where(
        `id = (
          SELECT id FROM announcements
           WHERE processed_at IS NULL
             AND claimed_at IS NULL
             AND scheduled_at <= now()
           ORDER BY scheduled_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )`,
      )
      .returning('*')
      .execute();

    const row = (result.raw as Announcement[] | undefined)?.[0];
    return row ?? null;
  }

  /**
   * Stamp `processed_at` and write the per-outcome counters. The `claim_token`
   * WHERE guard means a stale caller (whose claim was released by `releaseStuck`
   * and re-claimed by a peer) cannot clobber the peer's already-written
   * counters. Returns `true` on success, `false` if we lost the claim.
   */
  async markCompleted(
    id: number,
    token: string,
    result: CompletionResult,
  ): Promise<boolean> {
    const update = await this.announcementRepository
      .createQueryBuilder()
      .update(Announcement)
      .set({
        processed_at: () => 'now()',
        claimed_at: null,
        claim_token: null,
        recipient_count: result.recipientCount,
        delivered_count: result.deliveredCount,
        opted_out_count: result.optedOutCount,
        no_channel_count: result.noChannelCount,
        failed_count: result.failedCount,
        error: result.error ?? null,
      })
      .where('id = :id', { id })
      .andWhere('claim_token = :token', { token })
      .execute();
    return (update.affected ?? 0) > 0;
  }

  /**
   * Stamp `processed_at` + error WITHOUT a claim-token check. Used by the
   * scheduler's poison-row escape after the per-row attempt cap is reached:
   * we want to remove the row from contention regardless of who currently
   * owns it. Idempotent — repeated calls overwrite the same fields.
   */
  async markPoisoned(id: number, errorMessage: string): Promise<void> {
    await this.announcementRepository.update(id, {
      processed_at: () => 'now()',
      claimed_at: null,
      claim_token: null,
      recipient_count: 0,
      delivered_count: 0,
      opted_out_count: 0,
      no_channel_count: 0,
      failed_count: 0,
      error: errorMessage,
    });
  }

  /**
   * Release a claim without marking the row complete. Increments
   * `attempt_count` so the scheduler can stop releasing-and-retrying a
   * deterministically failing row across ticks. Returns the new attempt count
   * so the caller can decide whether to escape via `markPoisoned`.
   *
   * `claim_token` WHERE guard means we won't reset the claim a peer has
   * taken over (which would clobber the peer's heartbeats).
   */
  async releaseClaim(id: number, token: string): Promise<number> {
    const result = await this.announcementRepository
      .createQueryBuilder()
      .update(Announcement)
      .set({
        claimed_at: null,
        claim_token: null,
        attempt_count: () => 'attempt_count + 1',
      })
      .where('id = :id', { id })
      .andWhere('claim_token = :token', { token })
      .returning(['attempt_count'])
      .execute();
    const raw = (result.raw as { attempt_count: number }[] | undefined)?.[0];
    return raw?.attempt_count ?? 0;
  }

  /**
   * Heartbeat the claim during a long-running fan-out so `releaseStuck` doesn't
   * reclaim a row that's still being actively processed. Called periodically
   * from the dispatch loop.
   *
   * Returns `true` if the row is still claimable by us (claimed_at refreshed),
   * `false` if either (a) `releaseStuck` cleared our claim AND a peer's
   * `claimNextDue` re-claimed under a different `claim_token`, or (b) a peer
   * has already completed the row. The `claim_token` predicate is what makes
   * (a) a no-op — without it, our heartbeat would silently refresh the peer's
   * `claimed_at` and both replicas would race to `markCompleted`.
   */
  async heartbeatClaim(id: number, token: string): Promise<boolean> {
    const result = await this.announcementRepository
      .createQueryBuilder()
      .update(Announcement)
      .set({ claimed_at: () => 'now()' })
      .where('id = :id', { id })
      .andWhere('claim_token = :token', { token })
      .andWhere('processed_at IS NULL')
      .execute();
    return (result.affected ?? 0) > 0;
  }

  /**
   * Reset rows whose `claimed_at` is older than `staleAfterMs` and which never
   * completed. Returns the count of released rows for the log. Called at the
   * start of every scheduler tick so a crash-stranded row becomes claimable
   * within one tick interval (default 5 minutes after the crash). Dispatch
   * periodically heartbeats `claimed_at` so legitimate slow fan-outs are not
   * mistaken for stale claims.
   */
  async releaseStuck(staleAfterMs = 5 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - staleAfterMs);
    const result = await this.announcementRepository
      .createQueryBuilder()
      .update(Announcement)
      .set({ claimed_at: null, claim_token: null })
      .where('claimed_at IS NOT NULL')
      .andWhere('processed_at IS NULL')
      .andWhere('claimed_at < :cutoff', { cutoff })
      .execute();
    const released = result.affected ?? 0;
    if (released > 0) {
      this.logger.warn(`Released ${released} stuck announcement claim(s)`);
    }
    return released;
  }

  /** Addresses targeted by a `specific` announcement. */
  async addressesFor(announcementId: number): Promise<string[]> {
    const rows = await this.targetRepository.find({
      where: { announcement_id: announcementId },
      select: ['address'],
    });
    return rows.map((r) => r.address);
  }

  /**
   * Public feed: only broadcast (`target_type='all'`), feed-visible, processed
   * announcements. The previous `?address=` filter was dropped because it let
   * any caller enumerate which addresses were recipients of `specific` (DM-style)
   * announcements — the admin app reads `announcement_targets` directly via
   * Drizzle if it ever needs that view.
   */
  async listPublic(page: number, limit: number): Promise<Announcement[]> {
    return this.announcementRepository
      .createQueryBuilder('a')
      .where('a.processed_at IS NOT NULL')
      .andWhere('a.feed_visible = true')
      .andWhere("a.target_type = 'all'")
      .orderBy('a.processed_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();
  }
}

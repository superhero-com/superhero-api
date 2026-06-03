import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type AnnouncementTargetType = 'all' | 'specific';

/**
 * An admin-authored announcement. One row per announcement.
 *
 * Three lifecycle states (read off `claimed_at` + `processed_at`):
 *   pending   : claimed_at IS NULL     AND processed_at IS NULL
 *   in flight : claimed_at IS NOT NULL AND processed_at IS NULL
 *   completed : claimed_at IS NULL     AND processed_at IS NOT NULL
 *
 * `claimed_at` is stamped when the scheduler picks a row up, refreshed by
 * dispatch heartbeats during long fan-outs, AND cleared again by `markCompleted`
 * when dispatch finishes. A crash mid-dispatch leaves `claimed_at IS NOT NULL
 * AND processed_at IS NULL`; the scheduler's `releaseStuck()` sweep nulls
 * `claimed_at` after the row's last heartbeat is older than `staleClaimMs`,
 * returning it to the pending state for retry.
 *
 * `claim_token` is the row-level ownership identifier. Each `claimNextDue`
 * generates a fresh UUID and stamps it; every subsequent heartbeat / mark-
 * completed / release-claim WHERE-checks the token to detect peer takeover
 * (claim stolen by another replica after releaseStuck). Without this, two
 * replicas could call `markCompleted` on the same row and clobber counters.
 *
 * `attempt_count` is incremented on every release of an unhealthy claim (the
 * scheduler's dispatch-crash branch). After the configured cap, the scheduler
 * stamps the row completed-with-error instead of releasing it, so a
 * deterministic-but-slow poison bug doesn't loop forever across ticks.
 */
@Entity({ name: 'announcements' })
export class Announcement {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  title: string;

  @Column({ type: 'text' })
  description: string;

  /** When the announcement becomes due. Default now() = "send immediately". */
  @Index()
  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP(6)' })
  scheduled_at: Date;

  @Column({ type: 'varchar', default: 'all' })
  target_type: AnnouncementTargetType;

  /**
   * Whether the announcement appears in the public in-app feed. Default `true`
   * (bulk announcements). Individual notifications set this to `false` so they
   * deliver via push only — see the Subscribers feature.
   */
  @Column({ type: 'boolean', default: true })
  feed_visible: boolean;

  /**
   * Stamped when the scheduler claims this row (FOR UPDATE SKIP LOCKED). NULL
   * means "not in flight". A stuck `claimed_at` older than 5 minutes is reset
   * to NULL by `releaseStuck()` so the row can be re-claimed.
   */
  @Index()
  @Column({ type: 'timestamp', nullable: true })
  claimed_at: Date | null;

  /**
   * Row-level ownership UUID stamped at claim time. Heartbeat / markCompleted /
   * releaseClaim require this token in their WHERE clause, so a peer that has
   * since reclaimed the row (after releaseStuck) won't be clobbered by a
   * resuming original. Cleared on completion alongside `claimed_at`.
   */
  @Column({ type: 'varchar', nullable: true })
  claim_token: string | null;

  /**
   * Number of times this row has been released after a dispatch crash. The
   * scheduler stamps the row completed-with-error once this reaches the
   * configured cap, so a deterministic poison bug doesn't loop forever
   * across ticks.
   */
  @Column({ type: 'integer', default: 0 })
  attempt_count: number;

  /** Stamped after dispatch completes. NOT NULL means "won't be re-claimed". */
  @Index()
  @Column({ type: 'timestamp', nullable: true })
  processed_at: Date | null;

  /** Resolved audience size, written after fan-out (reporting only). */
  @Column({ type: 'integer', nullable: true })
  recipient_count: number | null;

  /**
   * Recipients we actually queued an Expo push for — does NOT include users
   * who opted out via notification preferences (see `opted_out_count`) or
   * channel-level failures (see `failed_count`).
   */
  @Column({ type: 'integer', nullable: true })
  delivered_count: number | null;

  /** Recipients with the announcement type disabled in their preferences. */
  @Column({ type: 'integer', nullable: true })
  opted_out_count: number | null;

  /**
   * Recipients with no registered channel for this notification type.
   * Distinct from `failed_count`: this is the per-user "unreachable on this
   * type" outcome, not a delivery failure that should page operators. After
   * dispatch, the invariant
   * `delivered_count + opted_out_count + no_channel_count + failed_count
   *  === recipient_count` holds.
   */
  @Column({ type: 'integer', nullable: true })
  no_channel_count: number | null;

  /** Recipients where every channel rejected the send. */
  @Column({ type: 'integer', nullable: true })
  failed_count: number | null;

  /** First channel error string (informational; the row still completes). */
  @Column({ type: 'text', nullable: true })
  error: string | null;

  /** Admin email (ADMIN_EMAIL) for a light audit trail. */
  @Column({ type: 'varchar', nullable: true })
  created_by: string | null;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at: Date;

  @UpdateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
    onUpdate: 'CURRENT_TIMESTAMP(6)',
  })
  updated_at: Date;
}

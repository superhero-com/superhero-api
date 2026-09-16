import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One row per X verification attempt.
 *
 * `profile_x_posting_rewards` already carries an `error` column, but it holds
 * only the LAST error and is overwritten on every run. That answers "is this
 * wallet stuck right now" and nothing else: you cannot see that an address has
 * failed the same way five times in three days, that twenty addresses started
 * failing within the same hour, or that a code which used to appear has stopped.
 * Those are the questions asked when the flow breaks, and until now the only way
 * to answer them was to be watching at the time — which is why breakage kept
 * surfacing during demos.
 *
 * Append-only. Nothing reads a row back to make a decision, so a write failure
 * here must never fail the verification it is describing.
 */
export type XVerificationAttemptOutcome = 'succeeded' | 'failed';

/** Where the attempt came from. Manual is the user pressing "Check rewards". */
export type XVerificationAttemptSource = 'manual_recheck' | 'link_intake';

@Entity({ name: 'profile_x_verification_attempts' })
// Per-address history: "show me everything this wallet tried".
@Index('idx_x_verification_attempts_address_created', ['address', 'created_at'])
// The dashboard's two questions: what is failing lately, and how often.
@Index('idx_x_verification_attempts_created', ['created_at'])
@Index('idx_x_verification_attempts_error_created', [
  'error_code',
  'created_at',
])
export class ProfileXVerificationAttempt {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  address: string;

  /**
   * The handle as it stood on the reward row at the time. Nullable because a
   * lookup can fail before one is known, and because the row must still be
   * written in that case — an attempt with no handle is exactly the kind we
   * most need to see.
   */
  @Column({ nullable: true })
  x_username: string | null;

  @Column({ enum: ['succeeded', 'failed'] })
  outcome: XVerificationAttemptOutcome;

  @Column({ enum: ['manual_recheck', 'link_intake'] })
  source: XVerificationAttemptSource;

  /**
   * The pipeline's own code (`x_user_lookup_failed`, `x_posts_fetch_failed`,
   * `payout_send_failed`, …). Null on success. Deliberately the same vocabulary
   * the reward row uses, so the dashboard does not need a second mapping.
   */
  @Column({ nullable: true })
  error_code: string | null;

  /**
   * Short human detail for the dashboard — an HTTP status, a rate-limit note.
   * Truncated on write: this is a debugging aid, not a log sink, and an
   * unbounded provider message should not be able to bloat the row.
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  detail: string | null;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at: Date;
}

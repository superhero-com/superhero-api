import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * An operator who may open the affiliation dashboards.
 *
 * Those pages join wallet address to X handle, follower count, payout amount
 * and transaction hash — a deanonymising join that cannot sit on an open URL.
 *
 * Credentials live here rather than in an environment variable because the
 * people who run this deployment cannot set environment variables, and rather
 * than in the repository because a committed hash can be attacked offline by
 * anyone with read access. Keeping the hash only in the database is what makes
 * a short, memorable password defensible: the only way at it is online, through
 * a rate-limited login.
 *
 * The password itself is never stored — only an Argon2id hash, which cannot be
 * reversed into the password.
 */
@Entity({ name: 'affiliation_dashboard_admins' })
@Index('idx_affiliation_dashboard_admins_username', ['username'], {
  unique: true,
})
export class AffiliationDashboardAdmin {
  @PrimaryGeneratedColumn()
  id: number;

  /** Stored lowercased so logins are not case-sensitive. */
  @Column({ type: 'varchar', length: 64 })
  username: string;

  /** Argon2id. Long enough for the encoded form plus its parameters. */
  @Column({ type: 'varchar', length: 255 })
  password_hash: string;

  /**
   * Consecutive failed logins, and when the lockout lifts. Kept per account
   * rather than only per IP so that distributing an attack across addresses
   * does not also multiply the number of guesses allowed.
   */
  @Column({ type: 'int', default: 0 })
  failed_login_count: number;

  @Column({ type: 'timestamp', nullable: true })
  locked_until: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  last_login_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}

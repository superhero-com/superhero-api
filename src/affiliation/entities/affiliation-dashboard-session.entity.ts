import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A logged-in browser session for the affiliation dashboards.
 *
 * Sessions live in a table rather than in a signed cookie because signing needs
 * a secret, and a secret needs somewhere to live — which is the very problem
 * this design exists to avoid. An opaque random token checked against a row
 * needs no key material at all.
 *
 * Only the token's SHA-256 is stored. A leaked database backup therefore does
 * not hand over live sessions, and the lookup is still a single indexed read.
 * One row per login, so the same person can be signed in on a laptop and a
 * phone, and signing out on one does not disturb the other.
 */
@Entity({ name: 'affiliation_dashboard_sessions' })
@Index('idx_affiliation_dashboard_sessions_token', ['token_hash'], {
  unique: true,
})
// Expiry sweeps delete by date; without this they would scan the table.
@Index('idx_affiliation_dashboard_sessions_expires', ['expires_at'])
export class AffiliationDashboardSession {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  admin_id: number;

  /** SHA-256 of the token held by the browser, hex-encoded. */
  @Column({ type: 'varchar', length: 64 })
  token_hash: string;

  @Column({ type: 'timestamp' })
  expires_at: Date;

  @CreateDateColumn()
  created_at: Date;
}

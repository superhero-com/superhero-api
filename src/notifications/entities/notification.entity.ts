import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One persisted notification for one recipient — the row that backs the web
 * in-app feed (bell list, unread badge, history). Written by the `database`
 * channel; read by the feed controller and pushed live by the gateway.
 *
 * Keyed by a bare `address` varchar with NO foreign key to `Account`, matching
 * `device_tokens` / `notification_preferences`: identity here is the æternity
 * key, and a brand-new address with no `Account` row must still be able to
 * receive (e.g.) an incoming-transfer notification.
 *
 * This table is a convenience cache over chain-derived events, not a system of
 * record — the retention cron prunes old read rows and caps rows per address.
 */
@Entity({ name: 'notifications' })
// Feed pagination + per-address cap: the list query and the retention window
// both filter by address and order/range by id (`WHERE address=? AND id<?
// ORDER BY id DESC`), so this is the index that actually serves them — a plain
// (address, created_at) index can't satisfy the id range/order without a sort.
@Index('notifications_address_id_idx', ['address', 'id'])
// Unread-count + mark-all-read scans.
@Index('notifications_address_read_at_idx', ['address', 'read_at'])
// Retention sweep #1 deletes read rows older than the horizon (no address
// filter), so a partial index on the read rows' created_at serves it directly.
@Index('notifications_retention_idx', ['created_at'], {
  where: 'read_at IS NOT NULL',
})
export class NotificationRecord {
  @PrimaryGeneratedColumn()
  id: number;

  /** Recipient æternity address (ak_…). Stored exactly as validated. */
  @Column()
  address: string;

  /** Notification type id from the catalog, e.g. 'incoming-transfer'. */
  @Column()
  type: string;

  @Column()
  title: string;

  @Column({ type: 'text' })
  body: string;

  /** Type-specific payload (txHash, sender, amount, deep-link hints, …). */
  @Column({ type: 'jsonb', nullable: true })
  data: Record<string, unknown> | null;

  /** Null until the recipient marks it read. Drives the unread badge. */
  @Column({ type: 'timestamp', nullable: true })
  read_at: Date | null;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at: Date;
}

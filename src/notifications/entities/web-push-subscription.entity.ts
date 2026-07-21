import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One row per browser Web Push subscription (Push API / VAPID). This is the web
 * counterpart to `device_tokens`: it lets the `web-push` channel deliver a
 * native OS notification even when no tab is open, complementing the live
 * websocket stream (open tab only) and the persisted feed (history).
 *
 * The push `endpoint` (the per-subscription URL the browser hands us) is the
 * natural unique key — re-subscribing the same browser yields the same endpoint,
 * so an upsert on it re-points the row to the currently-proven address and bumps
 * `last_seen_at`. `p256dh`/`auth` are the subscription's encryption keys the
 * `web-push` library needs to encrypt the payload.
 *
 * Keyed by a bare `address` varchar with NO foreign key to `Account`, matching
 * `device_tokens` / `notifications`: identity here is the æternity key.
 */
@Entity({ name: 'web_push_subscriptions' })
export class WebPushSubscription {
  @PrimaryGeneratedColumn()
  id: number;

  /** Recipient æternity address (ak_…). */
  @Index('web_push_subscriptions_address_idx')
  @Column()
  address: string;

  /** Per-subscription push service URL; unique natural key for the upsert. */
  @Index('web_push_subscriptions_endpoint_uq', { unique: true })
  @Column({ type: 'text' })
  endpoint: string;

  /** Client public key (base64url) used to encrypt the payload. */
  @Column({ type: 'text' })
  p256dh: string;

  /** Client auth secret (base64url) used to encrypt the payload. */
  @Column({ type: 'text' })
  auth: string;

  /** Optional UA string from the subscribing browser (diagnostics only). */
  @Column({ type: 'varchar', nullable: true })
  user_agent: string | null;

  /** Bumped on (re)subscribe; useful for future stale-subscription cleanup. */
  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP(6)' })
  last_seen_at: Date;

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

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export type DevicePlatform = 'ios' | 'android' | 'web';

/**
 * One row per device install. The Expo push token is the natural key (Expo issues
 * one per install) and is the proven secret for unregister flows.
 *
 * "One active account per device" is enforced atomically in `DeviceService.register`
 * via `INSERT … ON CONFLICT (expo_push_token) DO UPDATE … WHERE address = excluded`:
 * a register call for ak_A whose token is already owned by ak_B does NOT re-point
 * — it returns 409. Account switches must unregister first. The signature on the
 * registration message also commits to the token's SHA-256 fingerprint (see
 * `buildDeviceLinkMessage`), so a known-token attacker cannot reassign someone
 * else's device even with a valid signature for their own address.
 */
@Entity({ name: 'device_tokens' })
export class DeviceToken {
  @PrimaryColumn()
  expo_push_token: string;

  /** Currently-active account this device receives notifications for. */
  @Index()
  @Column()
  address: string;

  @Column({ type: 'varchar', nullable: true })
  platform: DevicePlatform | null;

  @Column({ type: 'varchar', nullable: true })
  app_version: string | null;

  /** Optional stable install id from the app (helps reason about re-installs). */
  @Column({ type: 'varchar', nullable: true })
  device_id: string | null;

  /** Bumped on register/heartbeat; the stale-device cleanup prunes by its age. */
  @Index()
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

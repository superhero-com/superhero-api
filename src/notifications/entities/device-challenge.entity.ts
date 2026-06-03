import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Short-lived, single-use nonce backing the signed device-registration handshake.
 * Mirrors the proven profile chain-name challenge pattern.
 */
@Entity({ name: 'notification_device_challenges' })
export class DeviceChallenge {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column()
  nonce: string;

  @Index()
  @Column()
  address: string;

  @Column({ type: 'timestamp' })
  expires_at: Date;

  /** Set on successful verify; an already-consumed challenge cannot be reused. */
  @Column({ type: 'timestamp', nullable: true })
  consumed_at: Date | null;

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

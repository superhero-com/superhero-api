import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Recipient list for `target_type = 'specific'`. Stays empty for `'all'` (which
 * resolves dynamically from `device_tokens` at send time). The unique
 * (announcement_id, address) index makes target inserts idempotent.
 */
@Entity({ name: 'announcement_targets' })
@Index('uq_announcement_targets', ['announcement_id', 'address'], {
  unique: true,
})
export class AnnouncementTarget {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column()
  announcement_id: number;

  @Index()
  @Column()
  address: string;
}

import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Per-(address, type) opt-out flag. Default behaviour (no row) is `enabled = true`
 * — rows are written only when the user explicitly overrides a type. The composite
 * PK `(address, type)` indexes both lookup directions; Postgres serves the
 * `WHERE address = …` query of the catalog merge from the same btree.
 */
@Entity({ name: 'notification_preferences' })
export class NotificationPreference {
  @PrimaryColumn()
  address: string;

  @PrimaryColumn()
  type: string;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

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

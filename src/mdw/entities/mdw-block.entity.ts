import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({
  name: 'mdw_block',
})
@Index(['height'])
@Index(['hash'])
@Index(['parent_hash'])
export class MdwBlock {
  @PrimaryColumn()
  height: number;

  @Column({ unique: true })
  hash: string;

  @Column()
  parent_hash: string;

  @Column({ type: 'timestamp' })
  timestamp: Date;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at: Date;

  @UpdateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  updated_at: Date;
}

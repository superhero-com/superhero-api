import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({
  name: 'profile_cache',
})
export class ProfileCache {
  @PrimaryColumn()
  address: string;

  @Column({ nullable: true })
  fullname: string;

  @Column({ nullable: true, type: 'text' })
  bio: string;

  @Column({ nullable: true, type: 'text' })
  avatarurl: string;

  @Column({ nullable: true })
  username: string;

  @Column({ nullable: true })
  x_username: string;

  @Column({ nullable: true })
  chain_name: string;

  @Column({ nullable: true })
  public_name: string;

  @Column({ nullable: true })
  display_source: string;

  @Column({ nullable: true, type: 'bigint' })
  chain_expires_at: string;

  @Column({ nullable: true, type: 'bigint' })
  last_seen_micro_time: string;

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

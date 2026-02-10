import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({
  name: 'profiles',
})
export class Profile {
  @PrimaryColumn()
  address: string;

  @Column({ nullable: true })
  fullname: string;

  @Column({ nullable: true, type: 'text' })
  bio: string;

  @Column({ nullable: true })
  nostrkey: string;

  @Column({ nullable: true })
  avatarurl: string;

  @Column({ nullable: true })
  username: string;

  @Column({ nullable: true })
  x_username: string;

  @Column({ nullable: true })
  chain_name: string;

  @Column({ nullable: true })
  sol_name: string;

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

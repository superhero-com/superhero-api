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

  @Column({ nullable: true, unique: true })
  username: string;

  @Column({ nullable: true })
  x_username: string;

  @Column({
    default: false,
  })
  x_verified: boolean;

  @Column({
    nullable: true,
    type: 'timestamp',
  })
  x_verified_at: Date | null;

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

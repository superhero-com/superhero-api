import { Account } from '@/account/entities/account.entity';
import { Post } from '@/social/entities/post.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

@Entity({
  name: 'tips',
})
export class Tip {
  @PrimaryColumn()
  tx_hash: string;

  @Column({
    default: 'profile',
  })
  type: string; // profile | post

  @ManyToOne(() => Account, (account) => account.address, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'sender_address' })
  sender: Account;

  @ManyToOne(() => Account, (account) => account.address, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'receiver_address' })
  receiver: Account;

  @ManyToOne(() => Post, (post) => post.tx_hash, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'post_id' })
  post: Post;

  @Column({
    default: '0',
  })
  amount: string;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

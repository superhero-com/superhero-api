import { Account } from '@/account/entities/account.entity';
import { Post } from '@/social/entities/post.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

// FK join columns (sender_address, receiver_address, post_id) are not
// auto-indexed by Postgres. Backs the tips list filter+order and the
// post-summary aggregate. Index names are shared with the idempotent
// migration bootstrap so synchronize-based and production environments
// converge on the same indexes.
@Index('IDX_TIPS_SENDER_CREATED', ['sender', 'created_at'])
@Index('IDX_TIPS_RECEIVER_CREATED', ['receiver', 'created_at'])
@Index('IDX_TIPS_POST_ID', ['post'])
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

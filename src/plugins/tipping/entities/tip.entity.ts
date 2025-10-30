import { Account } from '@/plugins/account/entities/account.entity';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Post } from '@/plugins/social/entities/post.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

@Entity({
  name: 'tipping_tips',
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

  @ManyToOne(() => Tx, (tx) => tx.hash, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tx_hash', referencedColumnName: 'hash' })
  tx: Tx;

  @Column({
    default: '0',
  })
  amount: string;

  //

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

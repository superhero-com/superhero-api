import { Account } from '@/account/entities/account.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Post } from '@/social/entities/post.entity';
import { MdwTx } from '@/mdw/entities/mdw-tx.entity';

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

  @ManyToOne(() => MdwTx, (tx) => tx.tx_hash, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tx_hash', referencedColumnName: 'tx_hash' })
  mdwTx: MdwTx;

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

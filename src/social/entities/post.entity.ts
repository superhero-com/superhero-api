import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Topic } from './topic.entity';
import { MdwTx } from '@/mdw/entities/mdw-tx.entity';

@Entity({
  name: 'posts',
})
export class Post {
  @PrimaryColumn()
  id: string;

  @Column({ nullable: true })
  post_id: string;

  @Column({ nullable: true })
  slug: string;

  @ManyToOne(() => Post, (post) => post.id, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'post_id' })
  parent_post: Post;

  @Column({
    unique: true,
  })
  tx_hash: string;

  @Column('json')
  tx_args: any[];

  @Column()
  sender_address: string;

  @Column()
  contract_address: string;

  @Column()
  type: string;

  @Column()
  content: string;

  @ManyToMany(() => Topic, (topic) => topic.posts, {
    cascade: true,
    eager: false,
  })
  @JoinTable({
    name: 'post_topics',
    joinColumn: {
      name: 'post_id',
      referencedColumnName: 'id',
    },
    inverseJoinColumn: {
      name: 'topic_id',
      referencedColumnName: 'id',
    },
  })
  topics: Topic[];

  @ManyToOne(() => MdwTx, (tx) => tx.tx_hash, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tx_hash', referencedColumnName: 'tx_hash' })
  mdwTx: MdwTx;

  @Column('json', { default: [] })
  media: string[];

  @Column()
  total_comments: number;

  @Column({
    default: false,
  })
  is_hidden: boolean;

  @Column({
    default: 0,
  })
  version: number;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

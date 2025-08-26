import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

@Entity({
  name: 'posts',
})
export class Post {
  @PrimaryColumn()
  id: string;

  @Column({ nullable: true })
  post_id: string;

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

  @Column('json', { default: [] })
  topics: string[];

  @Column('json', { default: [] })
  media: string[];

  @Column()
  total_comments: number;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

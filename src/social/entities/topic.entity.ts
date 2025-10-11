import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Post } from './post.entity';

@Entity({
  name: 'topics',
})
export class Topic {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    unique: true,
    length: 100,
  })
  name: string;

  @Column({
    nullable: true,
    length: 500,
  })
  description: string;

  @Column({
    default: 0,
  })
  post_count: number;

  @ManyToMany(() => Post, (post) => post.topics)
  posts: Post[];

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;

  @Column({
    default: 0,
  })
  version: number;

  @UpdateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
    onUpdate: 'CURRENT_TIMESTAMP(6)',
  })
  public updated_at: Date;
}

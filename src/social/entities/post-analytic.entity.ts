import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({
  name: 'post_analytics',
})
export class PostAnalytic {
  @PrimaryGeneratedColumn()
  id: string;

  @Column({
    type: 'date',
    unique: true,
  })
  public date: Date;

  @Column({ default: 0 })
  total_posts: number;

  @Column({ default: 0 })
  total_comments: number;

  @Column({ default: 0 })
  total_all: number;

  @Column({ default: 0 })
  total_unique_posters: number;

  @Column({ default: 0 })
  cumulative_total_posts: number;

  @Column({
    type: 'numeric',
    precision: 18,
    scale: 4,
    default: 0,
    transformer: {
      from: (value: string | null | undefined): number =>
        value == null ? 0 : Number(value),
      to: (value: number | null | undefined): number =>
        value == null ? 0 : value,
    },
  })
  avg_comments_per_post: number;
}

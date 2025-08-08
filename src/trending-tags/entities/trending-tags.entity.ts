import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({
  name: 'trending_tags',
})
export class TrendingTag {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({
    unique: true,
  })
  tag: string;

  @Column({
    nullable: true,
  })
  description: string;

  @Column()
  score: number;

  // platform (x, facebook, github)
  @Column()
  source: string;

  // Related token if already created
  @Column({
    nullable: true,
  })
  token_sale_address: string;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

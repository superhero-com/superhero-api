import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity({
  name: 'posts',
})
export class Post {
  @PrimaryColumn()
  id: string;

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

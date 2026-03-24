import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'token_eligibility_counts' })
export class TokenEligibilityCounts {
  @PrimaryColumn()
  symbol: string;

  @Column({ default: 0 })
  post_count: number;

  @Column({ default: 0 })
  stored_post_count: number;

  @Column({ default: 0 })
  content_post_count: number;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  refreshed_at: Date;
}

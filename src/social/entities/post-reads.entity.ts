import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'post_reads_daily' })
export class PostReadsDaily {
  @PrimaryColumn()
  post_id: string;

  @PrimaryColumn({ type: 'date' })
  date: string; // YYYY-MM-DD (date only)

  @Column({ type: 'integer', default: 0 })
  reads: number;
}



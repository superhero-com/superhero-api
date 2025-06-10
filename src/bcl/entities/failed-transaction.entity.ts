import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({
  name: 'failed_transactions',
})
export class FailedTransaction {
  @PrimaryColumn()
  hash: string; // transaction hash

  @Column({
    default: '',
  })
  error: string;

  // error trace
  @Column({
    default: '',
  })
  error_trace: string;

  @Column({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

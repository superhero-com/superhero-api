import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Affiliation } from './affiliation.entity';

@Entity({
  name: 'affiliation_codes',
})
export class AffiliationCode {
  @PrimaryGeneratedColumn()
  id: string;

  @ManyToOne(() => Affiliation, (affiliation) => affiliation.codes)
  affiliation: Affiliation;

  @Column({
    unique: true,
  })
  private_code: string;

  @Column({
    type: 'timestamp',
    nullable: true,
    default: null,
  })
  public claimed_at: Date;

  @Column({
    type: 'varchar',
    nullable: true,
    default: null, // `${provider}@${user_id}`
  })
  public claimed_by: string;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

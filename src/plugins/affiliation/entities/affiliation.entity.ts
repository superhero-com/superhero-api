import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AffiliationCode } from './affiliation-code.entity';

@Entity({
  name: 'affiliations',
})
export class Affiliation {
  @PrimaryGeneratedColumn()
  id: string;

  @Index()
  @Column()
  account_address: string;

  @Column({
    unique: true,
  })
  code: string;

  @OneToMany(() => AffiliationCode, (code) => code.affiliation, {
    cascade: true,
  })
  codes: AffiliationCode[];

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

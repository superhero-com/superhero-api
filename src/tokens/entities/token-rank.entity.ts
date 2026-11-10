import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Token } from './token.entity';

// Market-cap rank among unlisted=false tokens, written by
// RefreshTokenRanksService. A new token shifts the rank of every token below
// it, so this lives in a narrow table: on `token` each shift rewrote a wide
// row and all of its indexes. A token without a row has no rank yet.
@Entity({ name: 'token_rank' })
export class TokenRank {
  @PrimaryColumn()
  sale_address: string;

  @Index()
  @Column({ type: 'integer' })
  rank: number;

  @ManyToOne(() => Token, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sale_address', referencedColumnName: 'sale_address' })
  token?: Token;
}

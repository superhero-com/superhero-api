import { BigNumberTransformer } from '@/utils/BigNumberTransformer';
import {
  NOSTR_ROOM_STATES,
  NostrRoomState,
} from '@/token-gated-rooms/enums/nostr-room-state.enum';
import { BigNumber } from 'bignumber.js';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { IPriceDto } from '../dto/price.dto';

// Postgres int4 max -- safely outside any real rank (real ranks are ≤ the
// count of unlisted=false tokens). Used as the "not yet ranked" sentinel for
// `Token.rank` so an unranked row sorts last, not first, under `rank ASC`.
export const UNRANKED_TOKEN_RANK = 2147483647;

// Backs the home feed's token-creation source (`unlisted = false ORDER BY
// created_at DESC`), which previously had no covering index on this table.
@Index('IDX_TOKEN_UNLISTED_CREATED_AT', ['unlisted', 'created_at'])
@Entity({ name: 'token' })
export class Token {
  @PrimaryColumn()
  sale_address: string;

  @Index()
  @Column({
    default: false,
  })
  unlisted: boolean;

  @Column({
    nullable: true,
  })
  last_tx_hash: string;

  @Column({
    nullable: true,
  })
  last_sync_block_height: number;

  @Column({
    default: 0,
  })
  last_sync_tx_count: number;

  @Column({
    default: 0,
  })
  tx_count: number;

  @Column({
    default: 0,
  })
  holders_count: number;

  @Index()
  @Column({
    nullable: true,
  })
  factory_address: string;

  @Column({
    nullable: true,
  })
  create_tx_hash: string;

  @Column({
    nullable: true,
  })
  dao_address: string;

  @Index()
  @Column({
    default: null,
  })
  creator_address: string;

  @Column({
    default: null,
  })
  beneficiary_address: string;

  @Column({
    default: null,
  })
  bonding_curve_address: string;

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  dao_balance: BigNumber;

  @Index()
  @Column({
    default: null,
  })
  owner_address: string;

  /**
   * Basic Token Info
   */
  @Index()
  @Column({
    default: null,
  })
  address: string;

  @Index()
  @Column()
  name: string;

  @Index()
  @Column()
  symbol: string;

  @Column({
    default: 18,
    type: 'bigint',
  })
  decimals: string;

  @Column({
    nullable: true,
  })
  collection: string;

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  price: BigNumber;

  @Column({
    type: 'json',
    nullable: true,
  })
  price_data!: IPriceDto;

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  sell_price: BigNumber;

  @Column({
    type: 'json',
    nullable: true,
  })
  sell_price_data!: IPriceDto;

  @Index()
  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  market_cap: BigNumber;

  @Column({
    type: 'json',
    nullable: true,
  })
  market_cap_data!: IPriceDto;

  // Persisted market-cap rank among unlisted=false tokens, refreshed
  // periodically by RefreshTokenRanksService. Reading this column instead
  // of a live `RANK() OVER (...)` window function is what lets
  // queryTokensWithRanks skip re-sorting the whole token table on every
  // list request.
  //
  // Defaults to UNRANKED_TOKEN_RANK (last place), not 0: listings sort
  // `rank ASC` (1 = highest market cap), so a brand-new token would
  // otherwise outrank every real token until the next refresh cron tick.
  @Index()
  @Column({
    default: UNRANKED_TOKEN_RANK,
  })
  rank: number;

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  total_supply: BigNumber;

  // Middleware's AEX9 `event_supply`, tracked off the token's Mint/Burn/
  // Transfer event log; persisted so the token page can stop calling
  // `{mdw}/v3/aex9/{address}` from the browser just to read this field.
  @Column({
    type: 'numeric',
    nullable: true,
    transformer: BigNumberTransformer,
  })
  circulating_supply: BigNumber | null;

  @Index()
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 6,
    default: 0,
  })
  trending_score: number;

  @Column({
    type: 'timestamp',
    nullable: true,
  })
  trending_score_update_at: Date;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;

  /**
   * Token-gated rooms (plan §4.1).
   *
   * Immutable NIP-29 group id (= `sale_address` per D3); set once when the room
   * is requested. Index for room lookups by group id.
   */
  @Index()
  @Column({
    type: 'varchar',
    nullable: true,
  })
  nostr_group_id: string;

  /** True only after the relay ACKs the group create (set by later tasks). */
  @Column({
    default: false,
  })
  has_nostr_room: boolean;

  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  nostr_room_created_at: Date;

  /**
   * `nostr_room_state` machine (plan §4.7):
   *   none → pending → created; pending → failed; failed → pending (retry, capped
   *   backoff); pending stale >24h w/o ACK → re-publish (stays pending); relay
   *   `"Group already exists"` → created; community deleted → deleted (TERMINAL,
   *   relay blocks recreate of a 9008-deleted id).
   * Transition enforcement is Task 09 — see
   * `@/token-gated-rooms/enums/nostr-room-state.enum`.
   */
  @Index('idx_token_nostr_room_state_pending', ['nostr_room_state'], {
    where: "nostr_room_state <> 'created'",
  })
  @Column({
    type: 'enum',
    enum: NOSTR_ROOM_STATES,
    default: 'none',
  })
  nostr_room_state: NostrRoomState;

  /**
   * The NIP-29 group id (= `sale_address`) once the room is CONFIRMED created on
   * the relay; NULL = no room yet. Source of truth for the provisioning cron
   * (`room_id IS NULL` ⟺ not yet created). Set on the `9007` ok ACK
   * (`RoomBackfillService.onPublishAck`), the same place `has_nostr_room`/
   * `nostr_room_created_at` are stamped. Indexed (partial, `WHERE room_id IS NULL`)
   * for the roomless-token selection.
   */
  @Index('idx_token_room_id_null', ['room_id'], {
    where: 'room_id IS NULL',
  })
  @Column({
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  room_id: string;
}

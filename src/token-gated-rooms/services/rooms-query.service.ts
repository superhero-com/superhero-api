import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { Pagination, paginate, paginateRaw } from 'nestjs-typeorm-paginate';
import tgrConfig from '../config/tgr.config';
import { CommunityRoom } from '../entities/community-room.entity';
import {
  RoomMembership,
  RoomMembershipRelayState,
} from '../entities/room-membership.entity';
import { RoomViewDto } from '../dto/room.view.dto';
import { RoomMemberViewDto } from '../dto/room-member.view.dto';
import { RoomConfigViewDto } from '../dto/room-config.view.dto';

// nostr-tools subpaths via require() — same pattern as `nostr/pubkey.ts`. The
// package ENTRY pulls in ESM-only @noble/curves which ts-jest cannot transform;
// the `nip19` (bech32) + `pure` (key derivation) subpaths resolve fine at runtime
// and are on the jest transform whitelist (`nostr-tools|@noble|@scure`).
const nip19: {
  decode: (value: string) => { type: string; data: unknown };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
} = require('nostr-tools/nip19');

const nostrPure: {
  getPublicKey: (sk: Uint8Array) => string;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
} = require('nostr-tools/pure');

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Read-only query surface for the client room API (Task 13). MAIN-MODE ONLY — it
 * is the HTTP read path served by the API process. Reads straight from Postgres
 * (plan §9): the eligible-rooms list and members list ride the Task 00 indexes
 * (`idx_room_membership_eligible`, `idx_room_membership_sale_relay_state`,
 * `uq_room_membership_sale_member`). No chain reads, no relay I/O, no writes.
 */
@Injectable()
export class RoomsQueryService {
  constructor(
    @InjectRepository(CommunityRoom)
    private readonly roomRepo: Repository<CommunityRoom>,
    @InjectRepository(RoomMembership)
    private readonly membershipRepo: Repository<RoomMembership>,
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
  ) {}

  /**
   * Paginated rooms `address` is eligible for. Joins `room_membership` (the
   * caller's own row, `eligible=true`) to `community_room` (`deleted=false`).
   * Deterministic order: newest room first, then `sale_address` as a tiebreak so
   * pagination is stable across pages.
   */
  async listEligibleRooms(
    address: string,
    page: number,
    limit: number,
  ): Promise<Pagination<RoomViewDto>> {
    const qb: SelectQueryBuilder<RoomMembership> = this.membershipRepo
      .createQueryBuilder('rm')
      .innerJoin(CommunityRoom, 'cr', 'cr.sale_address = rm.sale_address')
      .where('rm.member_address = :address', { address })
      .andWhere('rm.eligible = true')
      .andWhere('cr.deleted = false')
      .select([
        'rm.id AS rm_id',
        'rm.sale_address AS sale_address',
        'rm.role AS role',
        'rm.relay_state AS relay_state',
        'rm.member_pubkey AS member_pubkey',
        'cr.token_address AS token_address',
        'cr.symbol AS symbol',
        'cr.is_private AS is_private',
        'cr.min_token_threshold AS min_token_threshold',
        'cr.is_community AS is_community',
        'cr.created_height AS created_height',
      ])
      .orderBy('cr.created_height', 'DESC', 'NULLS LAST')
      .addOrderBy('rm.sale_address', 'ASC');

    // Raw-row pagination: the SELECT mixes two tables, so use paginateRaw and
    // map raw rows → DTO (paginate() would call getMany() and drop the join cols).
    // Cast the builder to the raw-row shape — paginateRaw returns the selected
    // aliases, not RoomMembership entities.
    const { items, meta } = await paginateRaw<RawEligibleRoomRow>(
      qb as unknown as SelectQueryBuilder<RawEligibleRoomRow>,
      { page, limit },
    );
    return {
      items: items.map(toRoomViewDto),
      meta,
    } as Pagination<RoomViewDto>;
  }

  /**
   * Paginated members of a room. 404 if the room is unknown. Defaults to the
   * READABLE set (`relay_state='added'`) — the members actually published on the
   * relay; pass `includePending=true` to also surface eligible-but-not-yet-added
   * rows (the §6.6 unlinked / in-flight cases).
   */
  async listRoomMembers(
    saleAddress: string,
    page: number,
    limit: number,
    includePending = false,
  ): Promise<Pagination<RoomMemberViewDto>> {
    const room = await this.roomRepo.findOne({
      where: { sale_address: saleAddress },
    });
    if (!room) {
      throw new NotFoundException('Room not found');
    }

    const qb = this.membershipRepo
      .createQueryBuilder('rm')
      .where('rm.sale_address = :saleAddress', { saleAddress });
    if (!includePending) {
      qb.andWhere('rm.relay_state = :added', {
        added: 'added' as RoomMembershipRelayState,
      });
    }
    qb.orderBy('rm.member_address', 'ASC');

    const { items, meta } = await paginate(qb, { page, limit });
    return {
      items: items.map((rm) => ({
        member_address: rm.member_address,
        member_pubkey: rm.member_pubkey ?? null,
        role: rm.role,
        relay_state: rm.relay_state,
        eligible: rm.eligible,
      })),
      meta,
    };
  }

  /**
   * Relay handshake info for the app's NIP-42 AUTH (plan §16). `relay_url` is
   * `TG_RELAY_URL`; `admin_pubkey` is the bot pubkey in hex, derived from
   * `TG_BOT_NSEC` via nip19 (same decode as the worker's RelayWriter, which is
   * not loaded in main). The nsec is NEVER returned or logged here.
   */
  getRoomConfig(): RoomConfigViewDto {
    return {
      relay_url: this.config.nostrRelayUrl ?? '',
      admin_pubkey: this.deriveBotPubkeyHex(),
    };
  }

  /** Decode `TG_BOT_NSEC` → 32-byte secret → hex public key. */
  private deriveBotPubkeyHex(): string {
    const nsec = this.config.nostrBotNsec;
    if (!nsec) {
      // The relay may be unconfigured (the duties just stay dormant). Surface an
      // empty pubkey rather than crashing the read.
      return '';
    }
    try {
      const decoded = nip19.decode(nsec);
      if (decoded.type !== 'nsec' || !(decoded.data instanceof Uint8Array)) {
        return '';
      }
      return secretToPublicHex(decoded.data);
    } catch {
      // TG_BOT_NSEC is set but not a valid bech32 nsec — surface an empty pubkey
      // instead of 500-ing this read endpoint (the relay duties are dormant too).
      return '';
    }
  }
}

interface RawEligibleRoomRow {
  sale_address: string;
  token_address: string;
  symbol: string;
  is_private: boolean;
  // numeric column comes back as a string from pg/typeorm raw select
  min_token_threshold: string | null;
  is_community: boolean;
  role: RoomViewDto['role'];
  relay_state: RoomMembershipRelayState;
  member_pubkey: string | null;
}

/** Map a raw join row to the client DTO, deriving `readable` (§6.6). */
function toRoomViewDto(row: RawEligibleRoomRow): RoomViewDto {
  const memberPubkey = row.member_pubkey ?? null;
  return {
    sale_address: row.sale_address,
    token_address: row.token_address,
    symbol: row.symbol,
    is_private: row.is_private,
    min_token_threshold:
      row.min_token_threshold === null ? '0' : String(row.min_token_threshold),
    is_community: row.is_community,
    role: row.role,
    relay_state: row.relay_state,
    member_pubkey: memberPubkey,
    readable: row.relay_state === 'added' && memberPubkey !== null,
  };
}

/**
 * secp256k1 secret-key bytes → 32-byte x-only public key, hex (via
 * `nostr-tools/pure`'s `getPublicKey`). Kept here, not via the worker-only
 * RelayWriterService, because that writer is never constructed in the main API
 * process this controller runs in.
 */
function secretToPublicHex(sk: Uint8Array): string {
  const hex = nostrPure.getPublicKey(sk).toLowerCase();
  return HEX64.test(hex) ? hex : '';
}

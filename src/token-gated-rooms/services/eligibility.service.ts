import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { ConfigType } from '@nestjs/config';
import { Repository } from 'typeorm';
import { BigNumber } from 'bignumber.js';
import { CommunityRoom } from '../entities/community-room.entity';
import {
  RoomMembership,
  RoomMembershipRelayState,
  RoomMembershipRole,
} from '../entities/room-membership.entity';
import { TokenBalance } from '../entities/token-balance.entity';
import { IdentityService } from './identity.service';
import tgrConfig from '../config/tgr.config';
import {
  TGR_BALANCE_CHANGED,
  TGR_COMMUNITY_UPSERTED,
  TGR_ELIGIBILITY_CHANGED,
  TGR_LINK_CHANGED,
  TgrBalanceChangedPayload,
  TgrCommunityUpsertedPayload,
  TgrEligibilityChangedPayload,
  TgrLinkChangedPayload,
} from '../events';

/**
 * Replicate the bot's `toShiftedBigNumber(value, precision)` (matrix-defi-bot
 * `src/utils/aeternity.ts` lines 91-96): `new BigNumber(value).shiftedBy(Number(precision))`.
 *
 * Used ONLY where a human-unit amount must be converted to raw base units (e.g.
 * a threshold that ever arrives in human units). The hot eligibility comparison
 * is RAW-vs-RAW and never shifts (plan §5.4) — `Token.decimals` is a string, so
 * coerce with `Number(...)` exactly as the bot does.
 */
export function toShiftedBigNumber(
  value: BigNumber.Value,
  decimals: number | string | bigint,
): BigNumber {
  return new BigNumber(value).shiftedBy(Number(decimals));
}

/**
 * Pure eligibility predicate (plan §5.1, Task 06 req §2/§3). Decoupled from any
 * I/O so unit tests can exercise the threshold/decimals/mute edges directly.
 *
 * `eligible` iff the holder's **raw** balance meets the room's **raw** threshold
 * AND the member is not in the room's `muted` set. NO shifting at compare time —
 * both inputs are already raw integer base units (plan §5.4). A `null`/`undefined`
 * balance is treated as zero (the holder has no row yet).
 */
export function isEligible(
  balanceRaw: BigNumber.Value | null | undefined,
  thresholdRaw: BigNumber.Value | null | undefined,
  muted: readonly string[] | null | undefined,
  memberAddress: string,
): boolean {
  if (muted && muted.includes(memberAddress)) {
    return false;
  }
  const balance = new BigNumber(balanceRaw ?? 0);
  const threshold = new BigNumber(thresholdRaw ?? 0);
  return balance.gte(threshold);
}

/**
 * The single source of truth for *who should be in which room* (plan §5.1, Task
 * 06). Computes `eligible` per `(sale_address, member_address)` from raw token
 * balances vs. the room threshold (minus muted users), writes the **desired-state**
 * rows into `room_membership` (`eligible`, `role`, `member_pubkey`), applies the
 * desired `relay_state` transitions, and emits `tgr.eligibility.changed` ONLY on a
 * real flip. It reacts to balance / community / link changes via cursor-batched
 * recompute.
 *
 * ## Boundaries (out of scope here — owned elsewhere)
 * - It does **not** talk to the relay. Relay `9000`/`9001` publishing and the
 *   `relay_state` transitions to `added`/`removed` are Task 10 (membership-sync),
 *   which consumes `tgr.eligibility.changed`.
 * - It does **not** produce `tgr.balance.changed` (Task 03) or
 *   `tgr.community.upserted` (Task 04); it only consumes them.
 * - It only *reads* the resolved pubkey from {@link IdentityService} (Task 05).
 *
 * ## Unlinked-but-eligible invariant (plan §6.6 — VERIFIED)
 * Private-room access needs BOTH balance AND a Nostr link. An eligible holder with
 * no resolvable `member_pubkey` is recorded `eligible=true, member_pubkey=null,
 * relay_state='pending_add'` and is **never** advanced to `added` and **never**
 * flipped to `pending_remove` purely for the missing link. Task 10 skips such rows.
 *
 * ## Room-admin exemption (plan §6.7)
 * A row whose `role='admin'` is never set to `pending_remove` merely because its
 * balance dropped below threshold — configured room admins stay published.
 *
 * Registered as a MAIN-role provider (indexer concern; loads in `'main'` and
 * `'combined'`), `export: true`.
 */
@Injectable()
export class EligibilityService {
  private readonly logger = new Logger(EligibilityService.name);

  constructor(
    @InjectRepository(CommunityRoom)
    private readonly communityRoomRepo: Repository<CommunityRoom>,
    @InjectRepository(RoomMembership)
    private readonly membershipRepo: Repository<RoomMembership>,
    @InjectRepository(TokenBalance)
    private readonly tokenBalanceRepo: Repository<TokenBalance>,
    private readonly identity: IdentityService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
  ) {}

  /**
   * Cursor batch size for room-scoped recompute (plan §5.1). Reuses the existing
   * `reconcileBatchSize` knob (Task 01, default 500) rather than inventing a new
   * env var — the goal is short-held locks during Transfer bursts.
   */
  private get batchSize(): number {
    return this.config.reconcileBatchSize;
  }

  // ── trigger surfaces (req §6) ──────────────────────────────────────────────

  /**
   * A holder's AEX9 balance changed (Task 03). Recompute their eligibility across
   * every room backed by that token's AEX9 `address`
   * (`community_room.token_address`). The payload carries the AEX9 contract
   * `tokenAddress` + `holderAddress`.
   */
  @OnEvent(TGR_BALANCE_CHANGED, { async: true, promisify: true })
  async onBalanceChanged(payload: TgrBalanceChangedPayload): Promise<void> {
    const tokenAddress = payload?.tokenAddress;
    const holderAddress = payload?.holderAddress;
    if (!tokenAddress || !holderAddress) {
      return;
    }
    try {
      const rooms = await this.communityRoomRepo.find({
        where: { token_address: tokenAddress },
      });
      for (const room of rooms) {
        await this.recomputeMember(room, holderAddress);
      }
    } catch (error: any) {
      this.logger.error(
        `onBalanceChanged(${tokenAddress}, ${holderAddress}) failed`,
        error,
      );
    }
  }

  /**
   * A community-room desired-state row was created/updated (Task 04). Its
   * `min_token_threshold`, `moderators`, `muted`, or `deleted` may have changed →
   * full cursor-batched recompute of all members of that room (plan §5.1).
   */
  @OnEvent(TGR_COMMUNITY_UPSERTED, { async: true, promisify: true })
  async onCommunityUpserted(
    payload: TgrCommunityUpsertedPayload,
  ): Promise<void> {
    const saleAddress = payload?.saleAddress;
    if (!saleAddress) {
      return;
    }
    try {
      // Seed/refresh from the live holder set (not just rows already in
      // `room_membership`) so a freshly-created room — backfill or live
      // `create_community` — gets a membership row for every current holder, not
      // an empty roster. This is the bootstrap path for the existing token
      // registry (holders predate the room).
      await this.recomputeRoomFromHolders(saleAddress);
    } catch (error: any) {
      this.logger.error(`onCommunityUpserted(${saleAddress}) failed`, error);
    }
  }

  /**
   * An address↔nostr link changed (Task 05). {@link IdentityService} has already
   * mirrored the new `member_pubkey` onto every `room_membership` row for this
   * address; we re-evaluate eligibility for that member across its rooms so the
   * `relay_state` transition + emit fire for the (un)linked holder (e.g. an
   * eligible-but-unlinked holder linking becomes publishable).
   *
   * NOTE: IdentityService also consumes this same event independently; we both
   * react to the single emit (no re-broadcast loop) — see its class doc.
   */
  @OnEvent(TGR_LINK_CHANGED, { async: true, promisify: true })
  async onLinkChanged(payload: TgrLinkChangedPayload): Promise<void> {
    const address = payload?.address;
    if (!address) {
      return;
    }
    try {
      const rows = await this.membershipRepo.find({
        where: { member_address: address },
        select: ['sale_address'],
      });
      const saleAddresses = [...new Set(rows.map((r) => r.sale_address))];
      for (const saleAddress of saleAddresses) {
        const room = await this.communityRoomRepo.findOne({
          where: { sale_address: saleAddress },
        });
        if (room) {
          await this.recomputeMember(room, address);
        }
      }
    } catch (error: any) {
      this.logger.error(`onLinkChanged(${address}) failed`, error);
    }
  }

  // ── recompute paths ────────────────────────────────────────────────────────

  /**
   * Cursor-batched recompute of all members of one room (plan §5.1). Iterates
   * `WHERE sale_address=:x AND member_address > :cursor ORDER BY member_address
   * ASC LIMIT :N`, applying the upsert/transition per batch and advancing the
   * cursor to the last `member_address`, until a batch yields fewer than `N` rows.
   * Short-held locks avoid contention during Transfer bursts.
   *
   * Returns the number of `(sale_address, member_address)` rows whose `eligible`
   * flag flipped (for tests/observability).
   */
  async recomputeRoom(saleAddress: string): Promise<number> {
    const room = await this.communityRoomRepo.findOne({
      where: { sale_address: saleAddress },
    });
    if (!room) {
      return 0;
    }

    const limit = this.batchSize;
    let cursor = '';
    let flips = 0;

    for (;;) {
      const batch = await this.membershipRepo
        .createQueryBuilder('m')
        .where('m.sale_address = :sale', { sale: saleAddress })
        .andWhere('m.member_address > :cursor', { cursor })
        .orderBy('m.member_address', 'ASC')
        .limit(limit)
        .getMany();

      if (batch.length === 0) {
        break;
      }

      // Batch-resolve pubkeys for this page in one IN(...) read instead of
      // one findOne per member.
      const pubkeyByAddress = await this.identity.getPubkeysForAddresses(
        batch.map((row) => row.member_address),
      );

      for (const existing of batch) {
        const flipped = await this.recomputeMember(
          room,
          existing.member_address,
          existing,
          undefined,
          pubkeyByAddress.get(existing.member_address) ?? null,
        );
        if (flipped) {
          flips += 1;
        }
      }

      cursor = batch[batch.length - 1].member_address;
      if (batch.length < limit) {
        break;
      }
    }

    return flips;
  }

  /**
   * Seed/recompute a room's desired membership from the **live holder set** plus
   * any rows already tracked. `recomputeRoom` only revisits existing
   * `room_membership` rows, so it cannot bootstrap a brand-new room whose holders
   * predate it (the common case for the existing 54k-token registry). This walks
   * the union of:
   *   - current positive holders of the room's AEX9 token (`token_balance`),
   *   - existing membership rows (so a holder who dropped to zero is demoted), and
   *   - configured moderators (admins keep a row regardless of balance, §6.7),
   * recomputing each. Returns the number of `eligible` flips.
   *
   * MAIN-process bootstrap/seed path; consumed by `onCommunityUpserted`.
   */
  async recomputeRoomFromHolders(saleAddress: string): Promise<number> {
    const room = await this.communityRoomRepo.findOne({
      where: { sale_address: saleAddress },
    });
    if (!room) {
      return 0;
    }

    const addresses = new Set<string>();

    // 1) All holders of the room's AEX9 token — load balances ONCE into a map so
    //    the per-member recompute below never re-reads token_balance (perf).
    const holders = await this.tokenBalanceRepo.find({
      where: { token_address: room.token_address },
      select: ['holder_address', 'balance'],
    });
    const balanceByAddress = new Map<string, BigNumber>();
    for (const holder of holders) {
      const bal = new BigNumber(holder.balance ?? 0);
      balanceByAddress.set(holder.holder_address, bal);
      if (bal.gt(0)) {
        addresses.add(holder.holder_address);
      }
    }

    // 2) Existing membership rows (handle drops / mutes / unlinks on re-run) —
    //    load FULL rows ONCE into a map so the recompute passes them as `existing`
    //    instead of re-reading per member.
    const existingRows = await this.membershipRepo.find({
      where: { sale_address: saleAddress },
    });
    const membershipByAddress = new Map<string, RoomMembership>();
    for (const row of existingRows) {
      membershipByAddress.set(row.member_address, row);
      addresses.add(row.member_address);
    }

    // 3) Configured moderators stay published even at zero balance (§6.7).
    for (const moderator of room.moderators ?? []) {
      addresses.add(moderator);
    }

    // 4) Batch-resolve pubkeys for the WHOLE room roster in one IN(...) read
    //    instead of one findOne per member (identity.getPubkeyForAddress).
    const pubkeyByAddress = await this.identity.getPubkeysForAddresses([
      ...addresses,
    ]);

    let flips = 0;
    for (const address of addresses) {
      // Pass the pre-loaded membership row + balance (0 for a union member with no
      // positive holder row) so recomputeMember does no per-member reads here.
      const flipped = await this.recomputeMember(
        room,
        address,
        membershipByAddress.get(address) ?? null,
        balanceByAddress.get(address) ?? new BigNumber(0),
        pubkeyByAddress.get(address) ?? null,
      );
      if (flipped) {
        flips += 1;
      }
    }
    return flips;
  }

  /**
   * Recompute the desired state for a single `(room, member_address)`. Reads the
   * raw balance + resolved pubkey, derives `eligible`/`role`/`relay_state`, and
   * upserts the row ONLY when something actually changed (idempotency, req §9).
   * Emits `tgr.eligibility.changed` ONLY when the `eligible` flag flipped (req §8).
   *
   * @param existing optional already-loaded row (cursor-batch path) to avoid a
   *   re-read; when omitted we load it by `(sale_address, member_address)`.
   * @returns `true` iff the `eligible` flag flipped.
   */
  async recomputeMember(
    room: CommunityRoom,
    memberAddress: string,
    existing?: RoomMembership | null,
    balanceRaw?: BigNumber.Value | null,
    pubkeyOverride?: string | null,
  ): Promise<boolean> {
    // `existing === undefined` ⇒ not provided, load it. `existing === null` ⇒ the
    // caller already loaded the full room roster and this member has NO row (the
    // batch/seed path) — skip the per-member read entirely.
    const current =
      existing === undefined
        ? await this.membershipRepo.findOne({
            where: {
              sale_address: room.sale_address,
              member_address: memberAddress,
            },
          })
        : existing;

    // Resolved hex pubkey (or null) for the member — read-only (Task 05).
    // `pubkeyOverride === undefined` ⇒ not provided, look it up (single-member
    // reactive paths). Any other value (including null) ⇒ the caller already
    // batch-resolved pubkeys for the whole room/page — skip the per-member read.
    const memberPubkey =
      pubkeyOverride === undefined
        ? await this.identity.getPubkeyForAddress(memberAddress)
        : pubkeyOverride;

    // Role: configured moderator → admin, else member.
    const role: RoomMembershipRole = (room.moderators ?? []).includes(
      memberAddress,
    )
      ? 'admin'
      : 'member';

    // A deleted room desired-removes every member (req §2).
    let eligible: boolean;
    if (room.deleted) {
      eligible = false;
    } else {
      // Eligibility reads `token_balance`, the ledger kept current by the AEX9
      // transfer plugin for EVERY transfer (plain wallet-to-wallet, DEX swap,
      // airdrop) — not `token_holder`, which only reacts to BCL buy/sell calls
      // and would go stale on any other transfer. `community_room.token_address`
      // IS the AEX9 contract address (room-state.service sets it from
      // `Token.address`), so it maps directly to `token_balance.token_address`.
      // Raw-vs-raw compare — both are base units.
      // Perf: the seed/batch path (recomputeRoomFromHolders) has ALREADY loaded
      // every holder's balance, so it passes `balanceRaw` to skip a per-member
      // token_balance read (O(N) reads → 0 for a whole-room recompute). When not
      // provided (the single-member reactive paths), read it here.
      const holderBalance =
        balanceRaw !== undefined
          ? balanceRaw
          : ((
              await this.tokenBalanceRepo.findOne({
                where: {
                  token_address: room.token_address,
                  holder_address: memberAddress,
                },
              })
            )?.balance ?? null);
      eligible = isEligible(
        holderBalance,
        room.min_token_threshold,
        room.muted,
        memberAddress,
      );
    }

    const prevState: RoomMembershipRelayState | null =
      current?.relay_state ?? null;
    const relayState = this.nextRelayState(eligible, !!memberPubkey, role, {
      prevState,
    });

    const prevEligible = current?.eligible ?? false;
    const flipped = prevEligible !== eligible;

    // Idempotency (req §9): only write when a tracked field actually changes.
    const changed =
      !current ||
      current.eligible !== eligible ||
      current.role !== role ||
      (current.member_pubkey ?? null) !== (memberPubkey ?? null) ||
      current.relay_state !== relayState;

    if (!changed) {
      return false;
    }

    // A row that was never created and is ineligible (e.g. a deleted room with no
    // prior membership) has nothing to desired-remove — skip creating it.
    if (!current && !eligible) {
      return false;
    }

    await this.upsertMembership({
      saleAddress: room.sale_address,
      memberAddress,
      eligible,
      role,
      memberPubkey,
      relayState,
      existing: current,
    });

    // Notify membership-sync (Task 10) whenever there is something to publish, not
    // only on an eligible-flip. The link→invite case (§6.6): an already-eligible
    // holder who links their Nostr key does NOT flip `eligible`, but the row goes
    // from unpublishable (no pubkey) to a publishable `pending_add` — without this
    // it would only be picked up by the periodic scan (≤reconcileInterval later),
    // never reactively. Race-safe: keyed off the freshly-computed state (eligible +
    // resolved pubkey + pending_add), not the prior row's `member_pubkey` (which a
    // concurrent IdentityService link handler may already have written).
    const publishableAdd =
      eligible && !!memberPubkey && relayState === 'pending_add';
    if (flipped || publishableAdd) {
      this.emitEligibilityChanged(room.sale_address, memberAddress, eligible);
    }

    return flipped;
  }

  // ── desired-state transitions (req §5) ─────────────────────────────────────

  /**
   * Compute the desired `relay_state` (plan §4.3 — relay `39002` is the real
   * source of truth; this is desired-state only). This task only makes the
   * pending_* transitions; Task 10 advances pending → added/removed on ACK.
   *
   * - eligible & current ∈ {removed, pending_remove} (or none) → `pending_add`.
   * - ineligible & current ∈ {added, pending_add} → `pending_remove`.
   * - **Unlinked invariant (§6.6):** eligible but no pubkey → stay `pending_add`
   *   (never `added`); never flip an unlinked eligible member to `pending_remove`.
   * - **Admin exemption (§6.7):** a `role='admin'` row is never set to
   *   `pending_remove` purely for a balance drop — keep its current state.
   * - otherwise keep the current state (a pending/added row stays put).
   */
  nextRelayState(
    eligible: boolean,
    hasPubkey: boolean,
    role: RoomMembershipRole,
    opts: { prevState: RoomMembershipRelayState | null },
  ): RoomMembershipRelayState {
    const prev = opts.prevState;

    if (eligible) {
      // Unlinked-but-eligible: must remain unpublished until linked (§6.6).
      // Never flip an unlinked eligible member to pending_remove; pin to
      // pending_add regardless of the prior state.
      if (!hasPubkey) {
        return 'pending_add';
      }
      // Linked + eligible: schedule an add unless already added / pending_add.
      if (prev === 'added' || prev === 'pending_add') {
        return prev;
      }
      return 'pending_add';
    }

    // Ineligible. Admins are exempt from balance-gated removal (§6.7): keep state.
    if (role === 'admin') {
      return prev ?? 'pending_add';
    }

    if (prev === 'added' || prev === 'pending_add') {
      return 'pending_remove';
    }
    // Already removed / pending_remove / no row → desired-removed.
    return prev ?? 'removed';
  }

  // ── persistence ────────────────────────────────────────────────────────────

  /**
   * Upsert a single desired-state `room_membership` row. Updates the existing row
   * in place (preserving id + relay bookkeeping owned by Task 10/11) or inserts a
   * new one. Always refreshes `updated_at` (req §4).
   */
  private async upsertMembership(args: {
    saleAddress: string;
    memberAddress: string;
    eligible: boolean;
    role: RoomMembershipRole;
    memberPubkey: string | null;
    relayState: RoomMembershipRelayState;
    existing?: RoomMembership | null;
  }): Promise<void> {
    const {
      saleAddress,
      memberAddress,
      eligible,
      role,
      memberPubkey,
      relayState,
      existing,
    } = args;

    if (existing) {
      await this.membershipRepo.update(
        { id: existing.id },
        {
          eligible,
          role,
          member_pubkey: memberPubkey ?? null,
          relay_state: relayState,
          updated_at: new Date(),
        },
      );
      return;
    }

    await this.membershipRepo.insert({
      sale_address: saleAddress,
      member_address: memberAddress,
      eligible,
      role,
      member_pubkey: memberPubkey ?? null,
      relay_state: relayState,
      updated_at: new Date(),
    });
  }

  /** Emit the canonical `tgr.eligibility.changed` (thin payload, Shared contracts). */
  private emitEligibilityChanged(
    saleAddress: string,
    memberAddress: string,
    eligible: boolean,
  ): void {
    const payload: TgrEligibilityChangedPayload = {
      saleAddress,
      memberAddress,
      eligible,
    };
    this.eventEmitter.emit(TGR_ELIGIBILITY_CHANGED, payload);
  }
}

import { InjectQueue } from '@nestjs/bull';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { In, Repository } from 'typeorm';
import { Token } from '@/tokens/entities/token.entity';
import tgrConfig, { isRelayConfigured } from '../config/tgr.config';
import { CommunityRoom } from '../entities/community-room.entity';
import { RoomMembership } from '../entities/room-membership.entity';
import {
  TGR_COMMUNITY_UPSERTED,
  TGR_ELIGIBILITY_CHANGED,
  TGR_PUBLISH_ACK,
  TGR_ROOM_CREATED,
  type TgrCommunityUpsertedPayload,
  type TgrEligibilityChangedPayload,
  type TgrPublishAckPayload,
  type TgrRoomCreatedPayload,
} from '../events';
import {
  deleteGroup,
  NIP29_KIND,
  putUser,
  removeUser,
  setRoles,
} from '../nostr/nip29';
import { groupIdFor } from '../nostr/group-id';
import { publishNip29JobOptions } from '../queues/publish-nip29.job-options';
import { PUBLISH_NIP29_QUEUE } from '../queues/publish-nip29.processor';
import type { PublishNip29Job } from '../queues/publish-nip29.types';
import { RoomAdminsService } from './room-admins.service';
import { GroupMissingTracker } from './group-missing-tracker.service';
import { MembershipAccessService } from './membership-access.service';

/** NIP-29 relay role tokens (mirrors `room-admins.service.ts`). */
const NIP29_ROLE_ADMIN = 'admin';
const NIP29_ROLE_MEMBER = 'member';

/**
 * Name of the periodic publish-pending scan registered on the Nest
 * {@link SchedulerRegistry} (worker-only). The scan re-derives the pending working
 * set from `room_membership` every tick → resumable after a crash without losing
 * rows (idempotent at the relay; the `relay_state` ledger avoids redundant adds).
 */
export const MEMBERSHIP_SYNC_SCAN_JOB = 'tgr-membership-sync-scan';

/**
 * Whether a token's NIP-29 group is confirmed-created on the relay, i.e. it is
 * safe to publish members into it.
 *
 * `room_id` is the **durable** created-marker: it is stamped (= `sale_address`)
 * ONLY on the `9007` ok ACK (`RoomBackfillService.onPublishAck`) and has no column
 * default, so — unlike `nostr_room_state` — it survives a token re-index / schema
 * `synchronize` that resets defaulted columns back to `'none'`. We observed rooms
 * with `room_id` set but `nostr_room_state='none'` (the group exists on the relay,
 * but the state column was reset); gating membership promotion on `nostr_room_state`
 * alone left those members stuck at `pending_add` forever. Accept EITHER signal so
 * a desynced state column can never strand a holder who already has a real group.
 */
export function roomConfirmedCreated(
  token: { nostr_room_state?: string | null; room_id?: string | null } | null,
): boolean {
  if (!token) {
    return false;
  }
  return token.nostr_room_state === 'created' || token.room_id != null;
}

/**
 * Turn desired membership (Task 06's `room_membership` ledger) into actual relay
 * state — WORKER PROCESS ONLY (Task 10, plan §6.3 / §6.6 / §6.7 / §4.7).
 *
 * ## Role split (this task is the PUBLISHER; Task 06 is the DECIDER)
 * Task 06 computes `eligible`/`role`/`member_pubkey` and sets the *desired*
 * `relay_state` (`pending_add`/`pending_remove`), emitting the THIN
 * `tgr.eligibility.changed` (`{ saleAddress, memberAddress, eligible }`). This
 * service re-queries the row (events are thin by design — see `events.ts`),
 * enqueues the matching `9000`/`9001`/`9006`/`9008` onto Task 07's
 * `worker:publish-nip29` queue, and on the relay ACK seam (`tgr.publish.ack`)
 * flips the *pending* state to its terminal published value (`added`/`removed`).
 * It never recomputes eligibility, never opens a relay socket, never waits on ACK
 * transport (Task 07 owns rate/backoff/ACK/"already exists").
 *
 * ## Invariants enforced here
 * - **Unlinked-but-eligible (§6.6):** a `pending_add` row with `member_pubkey=null`
 *   is NEVER published — there is no pubkey to put-user. It stays `pending_add`
 *   until Task 05/06 fills the pubkey (which re-emits `tgr.eligibility.changed`).
 * - **Configured admins never balance-removed (§6.7):** before any `9001`,
 *   {@link RoomAdminsService.isConfiguredAdmin} gates the removal.
 * - **Never re-add a muted member (§5.1):** a member in `community_room.muted` is
 *   desired-removed; a stale `pending_add` for it enqueues NO `9000`.
 * - **Community deletion is terminal (§4.7):** one `9008` delete-group, no
 *   per-member `9001` fan-out; all rows set terminal `removed`.
 * - **Relay-owned idempotency (§6.3):** the `relay_state` ledger only avoids
 *   *redundant* publishes; there is NO process-local membership cache.
 *
 * Registered as a WORKER-role provider (loads in `'worker'` and `'combined'`),
 * `export: false`.
 */
@Injectable()
export class MembershipSyncService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(MembershipSyncService.name);
  private scanRunning = false;

  constructor(
    @InjectRepository(RoomMembership)
    private readonly membershipRepo: Repository<RoomMembership>,
    @InjectRepository(CommunityRoom)
    private readonly communityRoomRepo: Repository<CommunityRoom>,
    @InjectRepository(Token)
    private readonly tokenRepo: Repository<Token>,
    @InjectQueue(PUBLISH_NIP29_QUEUE)
    private readonly publishQueue: Queue<PublishNip29Job>,
    private readonly roomAdmins: RoomAdminsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly scheduler: SchedulerRegistry,
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
    // Optional so the existing positional-construction unit tests keep working; the
    // DI container always provides it in the running app.
    @Optional()
    private readonly groupMissing?: GroupMissingTracker,
    // Access-transition ledger (access-ledger plan): the sole emitter of the
    // membership push. `applyAck`/`handleDeletedRoom` fold relay-state transitions
    // into it instead of emitting `tgr.membership.changed` directly — so relay-sync
    // churn (reconcile re-adds, `39002` regen, flaps) no longer re-notifies. Optional
    // for the same positional-construction test reason; always DI-provided in-app.
    @Optional()
    private readonly membershipAccess?: MembershipAccessService,
  ) {}

  /**
   * Schedule the periodic publish-pending scan on the Nest {@link SchedulerRegistry}
   * — relay-gated (worker mode removed, see `deworker-plan.md`). The scan publishes
   * NIP-29 membership events, so we only schedule it when a relay is configured
   * (`isRelayConfigured`); otherwise this is a no-op. The interval re-derives the
   * pending set every tick → resumable after a crash without losing rows
   * (relay-owned idempotency, §6.3).
   *
   * The scan is NOT enqueued onto `worker:publish-nip29` (that queue's processor
   * only understands publish jobs); it is a local interval that ENQUEUES publishes,
   * exactly like the eligibility-driven path.
   */
  onModuleInit(): void {
    if (!isRelayConfigured(this.config)) {
      return;
    }
    const everyMs = Math.max(1, this.config.reconcileIntervalSec) * 1000;
    try {
      const interval = setInterval(() => {
        void this.runScanSafely();
      }, everyMs);
      interval.unref?.();
      this.scheduler.addInterval(MEMBERSHIP_SYNC_SCAN_JOB, interval);
      this.logger.log(
        `scheduled membership-sync scan every ${everyMs / 1000}s`,
      );
    } catch (error: any) {
      this.logger.warn(
        `failed to schedule membership-sync scan: ${error?.message ?? error}`,
      );
    }
  }

  /** Tear down the interval on shutdown so tests / restarts don't leak timers. */
  onApplicationShutdown(): void {
    try {
      if (this.scheduler.doesExist?.('interval', MEMBERSHIP_SYNC_SCAN_JOB)) {
        this.scheduler.deleteInterval(MEMBERSHIP_SYNC_SCAN_JOB);
      }
    } catch {
      // best-effort
    }
  }

  /** Run the scan with single-flight + error isolation (interval callback). */
  private async runScanSafely(): Promise<void> {
    if (this.scanRunning) {
      return;
    }
    this.scanRunning = true;
    try {
      await this.scanAndPublishPending();
    } catch (error: any) {
      this.logger.error(
        `membership-sync scan failed: ${error?.message ?? error}`,
      );
    } finally {
      this.scanRunning = false;
    }
  }

  // ── event surfaces ──────────────────────────────────────────────────────────

  /**
   * A member's eligibility flipped (Task 06). Re-query the desired-state row (the
   * event is thin by design) and publish the matching add/remove/role change. Task
   * 06 has already written `eligible`/`role`/`member_pubkey`/`relay_state`; we only
   * drive the *published* side.
   */
  @OnEvent(TGR_ELIGIBILITY_CHANGED, { async: true, promisify: true })
  async onEligibilityChanged(
    payload: TgrEligibilityChangedPayload,
  ): Promise<void> {
    const saleAddress = payload?.saleAddress;
    const memberAddress = payload?.memberAddress;
    if (!saleAddress || !memberAddress) {
      return;
    }
    try {
      const row = await this.membershipRepo.findOne({
        where: { sale_address: saleAddress, member_address: memberAddress },
      });
      if (!row) {
        return;
      }
      await this.publishForRow(row);
    } catch (error: any) {
      this.logger.error(
        `onEligibilityChanged(${saleAddress}, ${memberAddress}) failed`,
        error,
      );
    }
  }

  /**
   * A NIP-29 group was created + ACKed on the relay (Task 09). Now that the group
   * exists, publish every still-pending member of that room (rooms are eager-created
   * by Task 09 BEFORE their members are published — this drains the backlog).
   */
  @OnEvent(TGR_ROOM_CREATED, { async: true, promisify: true })
  async onRoomCreated(payload: TgrRoomCreatedPayload): Promise<void> {
    const saleAddress = payload?.saleAddress;
    if (!saleAddress) {
      return;
    }
    try {
      await this.publishPendingForRoom(saleAddress);
    } catch (error: any) {
      this.logger.error(`onRoomCreated(${saleAddress}) failed`, error);
    }
  }

  /**
   * A community-room desired-state row was upserted (Task 04). The ONLY delete
   * trigger (§4.7): when the room is now `deleted`, enqueue exactly one `9008`
   * delete-group (terminal at the relay) and mark every membership row terminal
   * `removed` — do NOT fan out per-member `9001`s. The payload is thin/typed; we
   * re-query `community_room.deleted` so we act on the persisted truth.
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
      const room = await this.communityRoomRepo.findOne({
        where: { sale_address: saleAddress },
      });
      if (room?.deleted) {
        await this.handleDeletedRoom(saleAddress);
      }
    } catch (error: any) {
      this.logger.error(`onCommunityUpserted(${saleAddress}) failed`, error);
    }
  }

  /**
   * Drive `relay_state` on the relay ACK seam (§6.3). Task 07's publish processor
   * is the SOLE emitter of `tgr.publish.ack`; this service consumes it and flips
   * the *pending* state to its terminal published value. It never observes the Bull
   * job result directly and never polls the relay (Task 11 owns read-back).
   *
   *   - `9000` add ok  → `relay_state='added'`,  set `last_published_at`.
   *   - `9001` remove ok → `relay_state='removed'`, set `last_published_at`.
   *   - `9006` role ok → confirm the published role (idempotent).
   *   - `ok=false` → leave `pending_*` untouched for Task 07 retry / Task 11.
   *   - re-observing an ACK for a row already terminal is a no-op (no write/event).
   */
  @OnEvent(TGR_PUBLISH_ACK, { async: true, promisify: true })
  async onPublishAck(payload: TgrPublishAckPayload): Promise<void> {
    if (!payload?.saleAddress || !payload.pubkey) {
      // Group-level publishes (no member pubkey) are Task 09's concern.
      return;
    }
    if (!payload.ok) {
      // Failed ACK: leave the pending state for retry / reconcile (Task 11).
      return;
    }
    const { saleAddress, pubkey, kind } = payload;
    if (
      kind !== NIP29_KIND.PUT_USER &&
      kind !== NIP29_KIND.REMOVE_USER &&
      kind !== NIP29_KIND.SET_ROLES
    ) {
      return;
    }
    try {
      const row = await this.membershipRepo.findOne({
        where: { sale_address: saleAddress, member_pubkey: pubkey },
      });
      if (!row) {
        return;
      }
      await this.applyAck(row, kind);
    } catch (error: any) {
      this.logger.error(
        `onPublishAck(${saleAddress}, kind=${payload.kind}) failed`,
        error,
      );
    }
  }

  // ── publish decisions ───────────────────────────────────────────────────────

  /**
   * Map one desired-state row → at most one publish. Idempotency (Req 10) is the
   * `relay_state` ledger: an `added` row (same role) or a `removed` row enqueues
   * nothing. The mute / unlinked / admin-exemption guards are the publish-side
   * belt-and-braces over Task 06's decisions.
   *
   * @returns true iff a publish was enqueued.
   */
  async publishForRow(row: RoomMembership): Promise<boolean> {
    const groupId = await this.resolveGroupId(row.sale_address);

    // A `deleted` room is terminal — never (re)publish members into it (§4.7).
    const room = await this.communityRoomRepo.findOne({
      where: { sale_address: row.sale_address },
    });
    if (room?.deleted) {
      return false;
    }

    if (row.relay_state === 'pending_add') {
      return this.maybeEnqueueAdd(row, room, groupId);
    }
    if (row.relay_state === 'pending_remove') {
      return this.maybeEnqueueRemove(row, groupId);
    }
    // `added` / `removed` are terminal published states: a re-delivered, unchanged
    // `tgr.eligibility.changed` for one of these enqueues NOTHING (Req 10
    // idempotency). Role transitions are NOT inferable from the thin eligibility
    // event (the on-disk eligibility service emits only on an `eligible` flip and
    // there is no published-role column to diff against), so they are driven
    // through the explicit {@link publishRoleChange} seam instead.
    return false;
  }

  /**
   * `pending_add`: enqueue `9000` put-user UNLESS the row is unlinked (§6.6) or
   * the member is currently muted (§5.1, never re-add while muted). An `admin`
   * role adds with `["p", pubkey, "admin"]` (mirrors the bot promote).
   */
  private async maybeEnqueueAdd(
    row: RoomMembership,
    room: CommunityRoom | null,
    groupId: string,
  ): Promise<boolean> {
    // §6.6: never publish an unlinked member (no pubkey → no valid `["p", …]`).
    if (!row.member_pubkey) {
      return false;
    }
    // The relay has no such group right now (a member add failed `"Group not found"`
    // and a re-create is in flight) — STOP piling adds onto a missing group. The
    // suppression clears on the re-create's `9007` ok-ACK, which re-fires
    // `tgr.room.created` → this scan re-runs and re-adds the members.
    if (this.groupMissing?.isMissing(row.sale_address)) {
      return false;
    }
    // §5.1: never re-add a member currently in the room's muted set.
    if (room?.muted && room.muted.includes(row.member_address)) {
      this.logger.debug(
        `skip 9000 for muted member ${row.member_address} in ${row.sale_address}`,
      );
      return false;
    }
    const role = row.role === 'admin' ? NIP29_ROLE_ADMIN : undefined;
    await this.enqueue(
      putUser(groupId, row.member_pubkey, role),
      groupId,
      row.sale_address,
      'membership-add',
    );
    return true;
  }

  /**
   * `pending_remove`: enqueue `9001` remove-user UNLESS the member is a configured
   * admin (§6.7 — admins are never balance-removed) or is unlinked (no pubkey to
   * remove). Configured-admin exemption is the publish-side guard over Task 06.
   */
  private async maybeEnqueueRemove(
    row: RoomMembership,
    groupId: string,
  ): Promise<boolean> {
    if (!row.member_pubkey) {
      // Nothing to remove on the relay (was never published).
      return false;
    }
    if (this.roomAdmins.isConfiguredAdmin(row.member_pubkey)) {
      this.logger.debug(
        `skip 9001 for configured admin ${row.member_pubkey} in ${row.sale_address}`,
      );
      return false;
    }
    await this.enqueue(
      removeUser(groupId, row.member_pubkey),
      groupId,
      row.sale_address,
      'membership-remove',
    );
    return true;
  }

  /**
   * Explicit role transition for an already-present member (Req 4, §6.7) — invoked
   * when a moderator-list change flips a member's desired `role` (member↔admin).
   * BOTH directions go through `9006` set-roles:
   *   - member → admin: `setRoles(['admin'])` (the relay also accepts a `9000`
   *     role=admin, but `9006` is symmetric and idempotent);
   *   - admin → member: `setRoles(['member'])` — NOT a `9000`, because the relay's
   *     `9000` never downgrades an existing admin (bot line 176-187 / relay
   *     last-admin guard).
   *
   * Respects the relay last-admin guard: a demotion of a configured admin is
   * refused (configured admins always stay admin, §6.7/§10) and logged — the bot
   * key always remains admin so this is not hit in normal operation. A no-op
   * (`fromRole === toRole`) enqueues nothing (idempotency).
   *
   * @returns true iff a `9006` was enqueued.
   */
  async publishRoleChange(
    saleAddress: string,
    memberAddress: string,
  ): Promise<boolean> {
    const row = await this.membershipRepo.findOne({
      where: { sale_address: saleAddress, member_address: memberAddress },
    });
    if (!row || !row.member_pubkey) {
      return false;
    }
    // Only an already-present member has a role to transition on the relay.
    if (row.relay_state !== 'added') {
      return false;
    }
    const groupId = await this.resolveGroupId(saleAddress);

    if (row.role === 'member') {
      // admin → member demotion: refuse to demote a configured admin (§6.7/§10).
      if (this.roomAdmins.isConfiguredAdmin(row.member_pubkey)) {
        this.logger.warn(
          `refusing to demote configured admin ${row.member_pubkey} in ` +
            `${saleAddress} (last-admin guard, §6.7)`,
        );
        return false;
      }
      await this.enqueue(
        setRoles(groupId, row.member_pubkey, [NIP29_ROLE_MEMBER]),
        groupId,
        saleAddress,
        'role-demote',
      );
      return true;
    }

    // member → admin promotion.
    await this.enqueue(
      setRoles(groupId, row.member_pubkey, [NIP29_ROLE_ADMIN]),
      groupId,
      saleAddress,
      'role-promote',
    );
    return true;
  }

  // ── ACK-driven state transitions (§6.3) ─────────────────────────────────────

  /**
   * Flip `relay_state` on a successful publish ACK (§6.3). Idempotent: a row
   * already at the terminal state for the ACKed kind is a no-op (no write, no
   * event). Emits `tgr.membership.changed` once per real transition (Req 9).
   */
  private async applyAck(row: RoomMembership, kind: number): Promise<void> {
    const now = new Date();

    if (kind === NIP29_KIND.PUT_USER) {
      if (row.relay_state === 'added') {
        return; // idempotent re-observed ACK
      }
      await this.membershipRepo.update(
        { id: row.id },
        { relay_state: 'added', last_published_at: now },
      );
      // Effective access GAINED — the ledger emits the (deduped) push.
      await this.recordAccess(row, true, 'access_gained');
      return;
    }

    if (kind === NIP29_KIND.REMOVE_USER) {
      if (row.relay_state === 'removed') {
        return; // idempotent re-observed ACK
      }
      await this.membershipRepo.update(
        { id: row.id },
        { relay_state: 'removed', last_published_at: now },
      );
      // Effective access LOST — the ledger arms the debounce (no push yet; a
      // re-add within the grace window cancels it, absorbing a flap).
      await this.recordAccess(row, false, 'eligibility_lost');
      return;
    }

    if (kind === NIP29_KIND.SET_ROLES) {
      // Role publish confirmed — stamp the publish time. A role change does NOT
      // change effective access (the member stays 'added'), so folding it into the
      // ledger is a no-op that will never produce a spurious "you now have access"
      // push (the old direct `emitMembershipChanged(row, 'role')` did).
      await this.membershipRepo.update(
        { id: row.id },
        { last_published_at: now },
      );
      await this.recordAccess(row, row.relay_state === 'added', 'role');
      return;
    }
  }

  /**
   * Fold a relay-state transition into the access-transition ledger (the sole
   * emitter of the membership push). No-op when the ledger service is absent (the
   * positional-construction unit tests) so relay_state bookkeeping still runs.
   */
  private async recordAccess(
    row: RoomMembership,
    effective: boolean,
    reason: string,
  ): Promise<void> {
    if (this.membershipAccess) {
      await this.membershipAccess.recordAccessTransition(row, effective, reason);
    }
  }

  // ── room-scoped scans (§6.3, resumable) ─────────────────────────────────────

  /**
   * Publish every still-pending member of a freshly-created room (`tgr.room.created`).
   * Cursor-batched by id to keep locks short under a large member set.
   */
  async publishPendingForRoom(saleAddress: string): Promise<number> {
    const token = await this.tokenRepo.findOne({
      where: { sale_address: saleAddress },
    });
    if (!roomConfirmedCreated(token)) {
      // The group does not exist yet — wait for the next `tgr.room.created`.
      return 0;
    }
    const groupId = groupIdFor({
      sale_address: saleAddress,
      nostr_group_id: token?.nostr_group_id,
    });
    const room = await this.communityRoomRepo.findOne({
      where: { sale_address: saleAddress },
    });
    if (room?.deleted) {
      return 0;
    }

    const limit = this.config.reconcileBatchSize;
    let cursorId = 0;
    let published = 0;

    for (;;) {
      const batch = await this.membershipRepo
        .createQueryBuilder('m')
        .where('m.sale_address = :sale', { sale: saleAddress })
        .andWhere('m.id > :cursor', { cursor: cursorId })
        .andWhere('m.relay_state IN (:...states)', {
          states: ['pending_add', 'pending_remove'],
        })
        .orderBy('m.id', 'ASC')
        .limit(limit)
        .getMany();

      if (batch.length === 0) {
        break;
      }
      for (const row of batch) {
        if (row.relay_state === 'pending_add') {
          if (await this.maybeEnqueueAdd(row, room, groupId)) {
            published += 1;
          }
        } else if (row.relay_state === 'pending_remove') {
          if (await this.maybeEnqueueRemove(row, groupId)) {
            published += 1;
          }
        }
      }
      cursorId = batch[batch.length - 1].id;
      if (batch.length < limit) {
        break;
      }
    }
    return published;
  }

  /**
   * Periodic / triggered resume scan (§6.3, idempotent + resumable). Selects
   * `room_membership WHERE relay_state IN ('pending_add','pending_remove')` for
   * rooms whose `Token.nostr_room_state='created'`, skipping unlinked
   * `pending_add` rows (NULL pubkey can never be published, §6.6). The
   * `pending_*` ledger + relay idempotency mean a re-run never double-adds. Called
   * by the repeatable {@link MEMBERSHIP_SYNC_SCAN_JOB} and exercised directly in
   * tests.
   *
   * @returns the number of publishes enqueued.
   */
  async scanAndPublishPending(): Promise<number> {
    const limit = this.config.reconcileBatchSize;
    let cursorId = 0;
    let published = 0;
    // Cache created-group + deleted lookups per room within a single scan.
    const roomReady = new Map<string, boolean>();
    const rooms = new Map<string, CommunityRoom | null>();
    const groupIds = new Map<string, string>();

    for (;;) {
      // §6.6 predicate: only rows that CAN be published —
      //   pending_add must have a non-null pubkey; pending_remove always qualifies.
      const batch = await this.membershipRepo
        .createQueryBuilder('m')
        .where('m.id > :cursor', { cursor: cursorId })
        .andWhere('m.relay_state IN (:...states)', {
          states: ['pending_add', 'pending_remove'],
        })
        .andWhere('(m.member_pubkey IS NOT NULL OR m.relay_state = :rm)', {
          rm: 'pending_remove',
        })
        .orderBy('m.id', 'ASC')
        .limit(limit)
        .getMany();

      if (batch.length === 0) {
        break;
      }

      for (const row of batch) {
        const sale = row.sale_address;
        let ready = roomReady.get(sale);
        if (ready === undefined) {
          const token = await this.tokenRepo.findOne({
            where: { sale_address: sale },
          });
          const room = await this.communityRoomRepo.findOne({
            where: { sale_address: sale },
          });
          ready = roomConfirmedCreated(token) && !room?.deleted;
          roomReady.set(sale, ready);
          rooms.set(sale, room ?? null);
          groupIds.set(
            sale,
            groupIdFor({
              sale_address: sale,
              nostr_group_id: token?.nostr_group_id,
            }),
          );
        }
        if (!ready) {
          continue;
        }
        const groupId = groupIds.get(sale) as string;
        const room = rooms.get(sale) ?? null;
        if (row.relay_state === 'pending_add') {
          if (await this.maybeEnqueueAdd(row, room, groupId)) {
            published += 1;
          }
        } else if (row.relay_state === 'pending_remove') {
          if (await this.maybeEnqueueRemove(row, groupId)) {
            published += 1;
          }
        }
      }

      cursorId = batch[batch.length - 1].id;
      if (batch.length < limit) {
        break;
      }
    }

    if (published > 0) {
      this.logger.log(
        `membership-sync scan enqueued ${published} pending publish(es)`,
      );
    }
    return published;
  }

  // ── community deletion (§4.7, terminal) ─────────────────────────────────────

  /**
   * Community deleted: enqueue exactly ONE `9008` delete-group (terminal at the
   * relay) and mark every membership row terminal `removed` — no per-member `9001`
   * fan-out. Idempotent: re-observing a delete on a room whose rows are already
   * `removed` enqueues a (relay no-op) `9008` once but writes nothing further.
   */
  private async handleDeletedRoom(saleAddress: string): Promise<void> {
    const groupId = await this.resolveGroupId(saleAddress);
    await this.enqueue(
      deleteGroup(groupId),
      groupId,
      saleAddress,
      'community-deleted',
    );

    // Mark all non-terminal rows removed (single bulk update; no per-member 9001).
    const rows = await this.membershipRepo.find({
      where: {
        sale_address: saleAddress,
        relay_state: In(['pending_add', 'added', 'pending_remove']),
      },
    });
    for (const row of rows) {
      await this.membershipRepo.update(
        { id: row.id },
        { relay_state: 'removed', last_published_at: new Date() },
      );
      // Fold into the access ledger — arms the debounced revoke (reason
      // room_deleted) for members who currently have access.
      await this.recordAccess(row, false, 'room_deleted');
    }
    this.logger.log(
      `community ${saleAddress} deleted: enqueued 9008 and removed ${rows.length} membership row(s)`,
    );
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  /** Resolve the NIP-29 group id for a sale (D3: `nostr_group_id ?? sale_address`). */
  private async resolveGroupId(saleAddress: string): Promise<string> {
    const token = await this.tokenRepo.findOne({
      where: { sale_address: saleAddress },
    });
    return groupIdFor({
      sale_address: saleAddress,
      nostr_group_id: token?.nostr_group_id,
    });
  }

  /** Enqueue one publish onto `worker:publish-nip29` with the §18 job options. */
  private async enqueue(
    template: PublishNip29Job['template'],
    groupId: string,
    saleAddress: string,
    reason: string,
  ): Promise<void> {
    await this.publishQueue.add(
      {
        template,
        groupId,
        meta: { saleAddress, reason: `membership:${reason}` },
      },
      publishNip29JobOptions(this.config.publishMaxRetries),
    );
  }
}

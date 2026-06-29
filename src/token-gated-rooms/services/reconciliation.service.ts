import { InjectQueue } from '@nestjs/bull';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { Repository } from 'typeorm';
import { Token } from '@/tokens/entities/token.entity';
import { SyncState } from '@/mdw-sync/entities/sync-state.entity';
import tgrConfig from '../config/tgr.config';
import { RoomMembership } from '../entities/room-membership.entity';
import { groupIdFor } from '../nostr/group-id';
import { putUser, removeUser } from '../nostr/nip29';
import { RELAY_WRITER, type RelayWriter } from '../nostr/relay-writer.contract';
import { publishNip29JobOptions } from '../queues/publish-nip29.job-options';
import { PUBLISH_NIP29_QUEUE } from '../queues/publish-nip29.processor';
import type { PublishNip29Job } from '../queues/publish-nip29.types';
import { RoomAdminsService } from './room-admins.service';

/** Hours/day, for the SLA-coverage math (req §4/§9). */
const HOURS_PER_DAY = 24;
const SECONDS_PER_DAY = HOURS_PER_DAY * 60 * 60;

/**
 * Result of reconciling one room against its relay `39002` (for tests/observability).
 */
export interface RoomReconcileResult {
  saleAddress: string;
  /** `9000` re-adds enqueued (eligible+linked members missing from `39002`). */
  added: number;
  /** `9001` re-removes enqueued (present-but-desired-removed non-admin members). */
  removed: number;
}

/**
 * Aggregate of one rotating reconcile batch run.
 */
export interface ReconcileBatchResult {
  /** Rooms actually read back this run. */
  roomsScanned: number;
  /** Total corrective `9000`s enqueued. */
  added: number;
  /** Total corrective `9001`s enqueued. */
  removed: number;
  /** The sale_address cursor advanced to (for the next run); null = wrapped. */
  nextCursor: string | null;
}

/**
 * Membership reconciliation (Task 11, plan §11 / §6.3) — WORKER process.
 *
 * The relay's kind-`39002` member list is the source of truth (`room_membership`
 * is desired-state + cache, §4.3); dropped publishes / same-`created_at` `39002`
 * regeneration races / transient drift are expected, so this is the periodic
 * safety net that makes membership *converge* to the desired-eligibility ledger.
 *
 * Per room it: (1) reads the authoritative `39002` set via Task 07's
 * {@link RelayWriter.fetchGroupMembers} on the existing authed connection (we
 * NEVER open a second socket); (2) diffs it against `room_membership`; (3)
 * self-heals drift by enqueuing corrective `9000`/`9001` through Task 07's
 * `worker:publish-nip29` queue. It also self-heals the admin set via
 * {@link RoomAdminsService.convergeRoomAdmins}.
 *
 * ## Coverage / SLA math (req §4/§9 — verbatim §18 defaults)
 *   TG_RECONCILE_BATCH_SIZE = 500 rooms/run, TG_RECONCILE_INTERVAL = 10m.
 *   runs/day  = 24h / 10m = 144
 *   coverage  = 500 × 144 = 72,000 room-reads/day
 *   rooms     ≈ 54,000  ⇒  every member's room is verified ≤ 24h (the §11 SLA),
 *               with ~33% headroom. If room count grows past ~72k, raise
 *               TG_RECONCILE_BATCH_SIZE or shorten TG_RECONCILE_INTERVAL so that
 *               batch × runs/day ≥ room_count (see {@link slaCoveragePerDay}).
 *
 * ## Drift rules (req §A.2)
 *   - should-be-added  = `eligible=true AND member_pubkey IS NOT NULL` rows whose
 *     pubkey is ABSENT from `39002`. Unlinked rows (`member_pubkey IS NULL`) are
 *     SKIPPED (§6.6 — they cannot be in `39002`, not drift).
 *   - should-be-removed = pubkeys PRESENT in `39002` whose row is `eligible=false`
 *     AND `role <> 'admin'` (§6.7 admin exemption) AND NOT within an unexpired
 *     reorg hold (`held_until_height` in the future, req §8 — intentionally still
 *     in `39002`).
 *   - `39002` == desired ⇒ NO publishes (idempotent, no spurious writes).
 *
 * Mode-gated: scheduling lives on the worker (see the reconcile processor);
 * methods here are pure DB+relay+queue so they unit-test without a process mode.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  /**
   * Rotating cursor: the last `sale_address` reconciled. The next run starts at
   * `sale_address > cursor` (stable ascending order) and wraps to the start when a
   * page returns fewer than the batch size — so the rotation walks the whole room
   * set across runs (req §4). In-memory is sufficient: a worker restart simply
   * re-starts the rotation from the top (idempotent — relay-owned).
   */
  private cursor = '';

  constructor(
    @InjectRepository(RoomMembership)
    private readonly membershipRepo: Repository<RoomMembership>,
    @InjectRepository(Token)
    private readonly tokenRepo: Repository<Token>,
    @InjectRepository(SyncState)
    private readonly syncStateRepo: Repository<SyncState>,
    @InjectQueue(PUBLISH_NIP29_QUEUE)
    private readonly publishQueue: Queue<PublishNip29Job>,
    @Inject(RELAY_WRITER)
    private readonly relay: RelayWriter,
    private readonly roomAdmins: RoomAdminsService,
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
  ) {}

  /** Reset the rotating cursor (tests). */
  resetCursor(): void {
    this.cursor = '';
  }

  /** Current rotating cursor value (tests/observability). */
  getCursor(): string {
    return this.cursor;
  }

  /**
   * SLA coverage in room-reads/day for the configured knobs (req §9). Task 15
   * asserts this is ≥ active-room-count; the unit test asserts the default
   * (500 × 144 = 72,000 ≥ 54,000).
   */
  slaCoveragePerDay(): number {
    const interval = Math.max(1, this.config.reconcileIntervalSec);
    const runsPerDay = SECONDS_PER_DAY / interval;
    return this.config.reconcileBatchSize * runsPerDay;
  }

  /**
   * Run one rotating, batched reconcile pass (req §4) — the body of the repeatable
   * `worker:reconcile-membership` job. Selects the next `TG_RECONCILE_BATCH_SIZE`
   * CREATED rooms (`Token.nostr_room_state='created'`, ordered by `sale_address`)
   * after the rotating cursor, reconciles each against its `39002`, advances the
   * cursor, and wraps at the end.
   *
   * Self-bounds load: rotating + batched, never a full scan (§8/§11). Backs off
   * entirely when the relay writer reports unhealthy (req §5 — do not burn
   * corrective publishes during an outage; the next run picks up where it left).
   */
  async reconcileBatch(): Promise<ReconcileBatchResult> {
    const empty: ReconcileBatchResult = {
      roomsScanned: 0,
      added: 0,
      removed: 0,
      nextCursor: this.cursor || null,
    };

    // Pause on relay outage (req §5): a `39002` read or a corrective publish would
    // both fail/queue uselessly — skip this run and retry next interval.
    if (typeof this.relay.isHealthy === 'function' && !this.relay.isHealthy()) {
      this.logger.warn('reconcileBatch: relay unhealthy — skipping this run');
      return empty;
    }

    const limit = this.config.reconcileBatchSize;
    const rooms = await this.tokenRepo
      .createQueryBuilder('t')
      .where('t.nostr_room_state = :created', { created: 'created' })
      .andWhere('t.sale_address > :cursor', { cursor: this.cursor })
      .orderBy('t.sale_address', 'ASC')
      .limit(limit)
      .getMany();

    if (rooms.length === 0) {
      // Wrap the rotation back to the start so the next run re-covers from the top.
      this.cursor = '';
      return { ...empty, nextCursor: null };
    }

    let added = 0;
    let removed = 0;
    for (const token of rooms) {
      try {
        const result = await this.reconcileRoom(token);
        added += result.added;
        removed += result.removed;
      } catch (error: any) {
        this.logger.error(
          `reconcileRoom(${token.sale_address}) failed: ${error?.message ?? error}`,
        );
      }
      // Advance the cursor even on a per-room failure so one bad room cannot wedge
      // the rotation (mirrors the balance-reconciliation cursor discipline).
      this.cursor = token.sale_address;
    }

    if (rooms.length < limit) {
      // Reached the end of the room set this run → wrap for the next one.
      this.cursor = '';
    }

    this.logger.debug(
      `reconcile batch: ${rooms.length} room(s), +${added} re-add, -${removed} re-remove`,
    );
    return {
      roomsScanned: rooms.length,
      added,
      removed,
      nextCursor: this.cursor || null,
    };
  }

  /**
   * Reconcile ONE room against its relay `39002` (req §A.1–§A.3). Reads the
   * authoritative member set once, diffs against the desired ledger, enqueues only
   * the corrective deltas (no spurious writes when `39002` already matches), then
   * self-heals the admin set via the relay's served admin list (Task 08 owns the
   * converge logic). Stamps `last_reconciled_at` on every row touched (req §5).
   */
  async reconcileRoom(token: Token): Promise<RoomReconcileResult> {
    const saleAddress = token.sale_address;
    const groupId = groupIdFor({
      sale_address: saleAddress,
      nostr_group_id: token.nostr_group_id,
    });

    // Authoritative `39002` set (hex pubkeys) on Task 07's authed connection. We
    // do NOT open a second socket; the read helper is owned by Task 07.
    const relayMembers = await this.relay.fetchGroupMembers(groupId);

    // Desired ledger for this room.
    const rows = await this.membershipRepo.find({
      where: { sale_address: saleAddress },
    });

    const current = await this.currentHeightSafe();

    const toAdd: RoomMembership[] = [];
    const toRemove: RoomMembership[] = [];

    // ── should-be-added: eligible + linked rows ABSENT from 39002 ──────────────
    for (const row of rows) {
      if (!row.eligible) {
        continue;
      }
      if (!row.member_pubkey) {
        // §6.6 unlinked invariant: cannot be in 39002, NOT drift-to-add.
        continue;
      }
      if (!relayMembers.has(row.member_pubkey)) {
        toAdd.push(row);
      }
    }

    // ── should-be-removed: pubkeys PRESENT in 39002 whose row is desired-removed ─
    // Index rows by pubkey for an O(1) lookup against the relay set.
    const byPubkey = new Map<string, RoomMembership>();
    for (const row of rows) {
      if (row.member_pubkey) {
        byPubkey.set(row.member_pubkey, row);
      }
    }
    for (const pubkey of relayMembers) {
      // Never auto-remove a configured admin (§6.7 / Task 08 owns admin converge).
      if (this.roomAdmins.isConfiguredAdmin(pubkey)) {
        continue;
      }
      const row = byPubkey.get(pubkey);
      if (!row) {
        // Present on the relay but no desired-state row: not THIS task's drift
        // (could be a configured admin seeded by Task 08, or stale). Leave it —
        // Task 08's admin converge / Task 10's ledger own those.
        continue;
      }
      if (row.role === 'admin') {
        continue; // §6.7 admin exemption
      }
      if (!row.eligible) {
        // Within an unexpired reorg hold → intentionally still in 39002 (req §8).
        if (this.isWithinReorgHold(row, current)) {
          continue;
        }
        toRemove.push(row);
      }
    }

    // ── emit corrective publishes (self-heal) ──────────────────────────────────
    for (const row of toAdd) {
      const role = row.role === 'admin' ? 'admin' : undefined;
      await this.enqueue(
        putUser(groupId, row.member_pubkey, role),
        groupId,
        saleAddress,
        'reconcile-readd',
      );
    }
    for (const row of toRemove) {
      await this.enqueue(
        removeUser(groupId, row.member_pubkey),
        groupId,
        saleAddress,
        'reconcile-reremove',
      );
    }

    // Admin-set self-heal (Task 08 converge). The relay's authoritative roles are
    // served on `39001`; this task does not read `39001` separately, so we let the
    // converge fall back to its own admin-aware diff (it filters non-admin pubkeys
    // and never demotes the bot). Idempotent: equal sets enqueue nothing.
    try {
      await this.roomAdmins.convergeRoomAdmins(saleAddress);
    } catch (error: any) {
      this.logger.warn(
        `convergeRoomAdmins(${saleAddress}) failed: ${error?.message ?? error}`,
      );
    }

    // Freshness (req §5): stamp every row of this room reconciled-now.
    await this.markReconciled(saleAddress);

    return { saleAddress, added: toAdd.length, removed: toRemove.length };
  }

  /**
   * Max staleness across active (created-room) memberships, in milliseconds — the
   * age of the OLDEST `last_reconciled_at` (req §5). Task 15 alerts when this
   * exceeds the SLA (e.g. > 24h ⇒ the rotation is starving). A `null`
   * `last_reconciled_at` (never reconciled) is treated as maximally stale and
   * returned as `Infinity`. Returns `0` when there are no rows.
   */
  async maxStalenessMs(): Promise<number> {
    const oldest = await this.membershipRepo
      .createQueryBuilder('m')
      .select('MIN(m.last_reconciled_at)', 'oldest')
      .addSelect(
        'COUNT(*) FILTER (WHERE m.last_reconciled_at IS NULL)',
        'never',
      )
      .addSelect('COUNT(*)', 'total')
      .getRawOne<{ oldest: Date | null; never: string; total: string }>();

    const total = Number(oldest?.total ?? 0);
    if (total === 0) {
      return 0;
    }
    if (Number(oldest?.never ?? 0) > 0) {
      // At least one membership has never been reconciled → maximally stale.
      return Number.POSITIVE_INFINITY;
    }
    if (!oldest?.oldest) {
      return Number.POSITIVE_INFINITY;
    }
    return Date.now() - new Date(oldest.oldest).getTime();
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  /**
   * True iff a desired-removed row is inside an unexpired reorg eviction hold
   * (`held_until_height` set and still in the future), so reconciliation must NOT
   * treat it as drift-to-remove (req §8). When the current height is unknown we
   * conservatively treat any set hold as unexpired (skip removal).
   */
  private isWithinReorgHold(
    row: RoomMembership,
    current: number | null,
  ): boolean {
    if (row.held_until_height === null || row.held_until_height === undefined) {
      return false;
    }
    if (current === null) {
      return true; // unknown height → be conservative, keep the member
    }
    return row.held_until_height > current;
  }

  /** Read tip height via SyncState (`id='global'`); `null` on any failure. */
  private async currentHeightSafe(): Promise<number | null> {
    try {
      const state = await this.syncStateRepo.findOne({
        where: { id: 'global' },
      });
      const tip = state?.tip_height;
      return typeof tip === 'number' && Number.isFinite(tip) ? tip : null;
    } catch {
      return null;
    }
  }

  /** Stamp `last_reconciled_at=now()` on every membership row of a room (req §5). */
  private async markReconciled(saleAddress: string): Promise<void> {
    await this.membershipRepo.update(
      { sale_address: saleAddress },
      { last_reconciled_at: new Date() },
    );
  }

  /** Enqueue one corrective publish onto `worker:publish-nip29` (Task 07 path). */
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
        meta: { saleAddress, reason: `reconcile:${reason}` },
      },
      publishNip29JobOptions(this.config.publishMaxRetries),
    );
  }
}

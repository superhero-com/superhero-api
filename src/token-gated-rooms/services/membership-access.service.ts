import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import tgrConfig from '../config/tgr.config';
import { RoomMembership } from '../entities/room-membership.entity';
import { RoomMembershipEvent } from '../entities/room-membership-event.entity';
import {
  TGR_MEMBERSHIP_CHANGED,
  type TgrMembershipChangedPayload,
} from '../events';

/**
 * Access-transition detector + debounce finalizer (access-ledger plan §3.4/§3.5).
 *
 * ## Why this exists
 * The membership push used to fire off the raw `relay_state: pending_add → added`
 * ACK — a *relay-sync* signal that churns (reconcile re-adds, `39002`
 * regeneration, a transient `eligible` flap cycling `added → removed → added`).
 * Result: "You now have access to X" re-fired ~hourly (thinned only by the 1h
 * Redis dedup TTL) for every room a holder was in.
 *
 * This service makes notifications fire off **effective-access transitions**
 * (`effective access = relay_state === 'added'`), recorded in a durable ledger
 * (`room_membership_event`) with a short **debounce** on loss:
 *  - GAIN (`none → granted`): recorded + pushed immediately (first-ever = "join",
 *    otherwise "regained").
 *  - LOSS (`granted → …`): NOT pushed immediately — `pending_revoke_since` is armed;
 *    a re-add within `TG_ACCESS_REVOKE_GRACE_SEC` cancels it silently (flap absorbed,
 *    no push either way); otherwise the finalizer emits ONE `access_revoked`.
 *
 * Reconcile re-adds / `39002` regeneration never change `access_state`, so they
 * never notify — the hourly repeat is fixed structurally, independent of whether
 * the underlying balance flap is also fixed (that's the separate §8 follow-up).
 *
 * The emitted event is the existing `tgr.membership.changed`, now enriched with the
 * ledger `accessEventId` + `isFirstGrant` so the room-notify processor can pick the
 * copy and stamp `notified_at` (durable dedup across Bull retries / restarts).
 */
@Injectable()
export class MembershipAccessService {
  private readonly logger = new Logger(MembershipAccessService.name);

  constructor(
    @InjectRepository(RoomMembership)
    private readonly membershipRepo: Repository<RoomMembership>,
    @InjectRepository(RoomMembershipEvent)
    private readonly eventRepo: Repository<RoomMembershipEvent>,
    private readonly eventEmitter: EventEmitter2,
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
  ) {}

  /**
   * Fold a relay-state transition into the effective-access ledger. Called from
   * every seam that writes `relay_state` (membership-sync `applyAck` +
   * `handleDeletedRoom`).
   *
   * @param row       the membership row (pre-write access columns are read from it;
   *                  `relay_state` has already been written by the caller).
   * @param effective the NEW effective access (`relay_state === 'added'`).
   * @param reason    the loss reason to persist through the debounce (grants derive
   *                  their own `join`/`regained` reason and ignore this).
   */
  async recordAccessTransition(
    row: RoomMembership,
    effective: boolean,
    reason: string,
  ): Promise<void> {
    try {
      if (effective) {
        await this.onAccessGained(row);
      } else {
        await this.onAccessLost(row, reason);
      }
    } catch (error) {
      // Access bookkeeping must never break the membership-sync ACK loop.
      this.logger.error(
        `recordAccessTransition(${row.sale_address}, ${row.member_address}, effective=${effective}) failed`,
        error as Error,
      );
    }
  }

  /** relay_state is now 'added' → the member has room access. */
  private async onAccessGained(row: RoomMembership): Promise<void> {
    if (row.access_state === 'granted') {
      // Already granted. If a revoke was armed (a flap: removed then re-added
      // within the grace window), cancel it silently — no push either way.
      if (row.pending_revoke_since) {
        await this.membershipRepo.update(
          { id: row.id },
          { pending_revoke_since: null, pending_revoke_reason: null },
        );
      }
      return;
    }

    // Genuine transition none → granted. **Atomic compare-and-set**: condition the
    // flip on the prior `access_state='none'` so only ONE handler wins when the same
    // relay ACK is processed concurrently (publish concurrency ≥ 2 → duplicate 9000
    // ACKs for one member). A racing/duplicate handler matches 0 rows and returns
    // WITHOUT inserting a ledger row or emitting — no duplicate event, no duplicate push.
    const now = new Date();
    const result = await this.membershipRepo.update(
      { id: row.id, access_state: 'none' },
      {
        access_state: 'granted',
        access_changed_at: now,
        pending_revoke_since: null,
        pending_revoke_reason: null,
      },
    );
    if (!result.affected) {
      return; // lost the race — another handler already granted this transition
    }

    // Only the winner counts + inserts (so `priorGrants` never includes this
    // transition's own row → correct first-grant detection under concurrency).
    const priorGrants = await this.eventRepo.count({
      where: {
        sale_address: row.sale_address,
        member_address: row.member_address,
        event: 'access_granted',
      },
    });
    const isFirst = priorGrants === 0;

    const event = await this.eventRepo.save(
      this.eventRepo.create({
        sale_address: row.sale_address,
        member_address: row.member_address,
        event: 'access_granted',
        reason: isFirst ? 'join' : 'regained',
        is_first_grant: isFirst,
      }),
    );

    this.emit(row, 'added', event.id, isFirst, event.reason);
  }

  /** relay_state is now removed → arm the revoke debounce (no push yet). */
  private async onAccessLost(
    row: RoomMembership,
    reason: string,
  ): Promise<void> {
    if (row.access_state !== 'granted') {
      // Never had (notified) access — nothing to revoke (e.g. an unlinked member
      // that was never granted, or an already-revoked row).
      return;
    }
    if (row.pending_revoke_since) {
      return; // already armed — keep the earliest arm time
    }
    await this.membershipRepo.update(
      { id: row.id },
      {
        pending_revoke_since: new Date(),
        pending_revoke_reason: reason || 'access_lost',
      },
    );
  }

  /**
   * Finalize armed revokes whose grace window has elapsed (access-ledger plan §3.5).
   * Pure DB + event-emit — safe to run regardless of relay configuration. Scheduled
   * as a repeatable job by `ReconcileProcessor`.
   *
   * For each row with `pending_revoke_since <= now - grace`:
   *  - re-added during grace (`relay_state='added'`) → clear the arm, no push (flap
   *    absorbed);
   *  - still removed → record ONE `access_revoked` + push, flip `access_state='none'`.
   */
  async finalizeDueRevokes(): Promise<{ revoked: number; cancelled: number }> {
    const graceMs = Math.max(0, this.config.accessRevokeGraceSec) * 1000;
    const cutoff = new Date(Date.now() - graceMs);

    const due = await this.membershipRepo.find({
      where: { pending_revoke_since: LessThanOrEqual(cutoff) },
      take: 500,
    });

    let revoked = 0;
    let cancelled = 0;
    for (const row of due) {
      try {
        if (row.relay_state === 'added' || row.access_state !== 'granted') {
          // Re-added during the grace window, or already resolved elsewhere —
          // clear the arm silently.
          await this.membershipRepo.update(
            { id: row.id },
            { pending_revoke_since: null, pending_revoke_reason: null },
          );
          if (row.relay_state === 'added') {
            cancelled += 1;
          }
          continue;
        }

        const reason = row.pending_revoke_reason || 'access_lost';
        const now = new Date();
        // Atomic compare-and-set (mirror the grant path): only flip a still-`granted`
        // row so overlapping finalizer runs can't emit two `access_revoked` rows/pushes.
        const result = await this.membershipRepo.update(
          { id: row.id, access_state: 'granted' },
          {
            access_state: 'none',
            access_changed_at: now,
            pending_revoke_since: null,
            pending_revoke_reason: null,
          },
        );
        if (!result.affected) {
          continue; // lost the race — already resolved elsewhere
        }
        const event = await this.eventRepo.save(
          this.eventRepo.create({
            sale_address: row.sale_address,
            member_address: row.member_address,
            event: 'access_revoked',
            reason,
            is_first_grant: false,
          }),
        );
        this.emit(row, 'removed', event.id, false, reason);
        revoked += 1;
      } catch (error) {
        this.logger.error(
          `finalizeDueRevokes: row ${row.id} (${row.sale_address}/${row.member_address}) failed`,
          error as Error,
        );
      }
    }

    if (revoked > 0 || cancelled > 0) {
      this.logger.debug(
        `finalizeDueRevokes: revoked=${revoked} cancelled=${cancelled}`,
      );
    }
    return { revoked, cancelled };
  }

  /** Emit the enriched `tgr.membership.changed` for a real access transition. */
  private emit(
    row: RoomMembership,
    relayState: TgrMembershipChangedPayload['relayState'],
    accessEventId: string,
    isFirstGrant: boolean,
    reason: string,
  ): void {
    const payload: TgrMembershipChangedPayload = {
      saleAddress: row.sale_address,
      memberAddress: row.member_address,
      relayState,
      accessEventId,
      isFirstGrant,
      reason,
    };
    this.eventEmitter.emit(TGR_MEMBERSHIP_CHANGED, payload);
  }
}

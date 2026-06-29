import { InjectQueue } from '@nestjs/bull';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { In, Not, Repository } from 'typeorm';
import { Token } from '@/tokens/entities/token.entity';
import { SyncState } from '@/mdw-sync/entities/sync-state.entity';
import tgrConfig from '../config/tgr.config';
import { RoomMembership } from '../entities/room-membership.entity';
import { groupIdFor } from '../nostr/group-id';
import { removeUser } from '../nostr/nip29';
import { publishNip29JobOptions } from '../queues/publish-nip29.job-options';
import { PUBLISH_NIP29_QUEUE } from '../queues/publish-nip29.processor';
import type { PublishNip29Job } from '../queues/publish-nip29.types';
import { RoomAdminsService } from './room-admins.service';

/**
 * The single `SyncState` row id (PK `id='global'`) carrying the chain tip height
 * (mirrors `sync-state.entity.ts`). We read `tip_height` as the single agreed
 * "current height" for both the buffer math (`bufferEvictions`) and the flush
 * gate (`flushDueEvictions`) — req §6/§7.
 */
const SYNC_STATE_ID = 'global';

/**
 * Reorg-gated membership eviction (Task 11, plan §6.5). Splits the eviction of a
 * member who *became ineligible because of a reorg* into two phases so a transient
 * fork never flaps a member out of `39002`:
 *
 *  1. {@link bufferEvictions} — called from the indexer-side plugins' `onReorg`
 *     (Tasks 03/04, MAIN process). After the plugin recomputes desired
 *     eligibility, the newly-ineligible non-admin members are *buffered*: we stamp
 *     `room_membership.held_until_height = tip_height + TG_REORG_CONFIRMATION_DEPTH_BLOCKS`
 *     and leave `relay_state='added'` (still in `39002`). NO `9001` is enqueued
 *     here (req §6) — `onReorg` fires synchronously in main and must only do cheap
 *     Postgres writes (plan §6.5 / task Context).
 *  2. {@link flushDueEvictions} — a scheduled WORKER job (req §7). It selects rows
 *     whose hold has passed (`held_until_height <= tip_height`) and, for each that
 *     is *still* ineligible, enqueues the `9001` `removeUser` via the Task 07
 *     `worker:publish-nip29` queue (flipping the row to `pending_remove` +
 *     clearing the hold so the existing ACK seam — Task 10 `onPublishAck` — drives
 *     it to `removed`). A row that became `eligible=true` again before the hold
 *     passed has its eviction CANCELLED (clear hold, stay `added`, no publish).
 *
 * ## Cost (req §10 — stated for §11)
 * Depth `TG_REORG_CONFIRMATION_DEPTH_BLOCKS` (default `10`) ≈ the reorg-confirmation
 * window: an eviction is delayed at most ~10 blocks of chain time. A transient
 * fork that reverts within depth costs **zero** relay publishes (the eviction is
 * cancelled at flush). The only relay load is the (rare) genuine evictions.
 *
 * Registered `mode: 'shared'` (`bufferEvictions` runs in main from the plugins;
 * the flush + its scheduling are worker-gated internally via the owning
 * {@link ReconciliationService}). Holds NO relay socket; the publish transport is
 * Task 07's queue.
 */
@Injectable()
export class ReorgEvictionService {
  private readonly logger = new Logger(ReorgEvictionService.name);

  constructor(
    @InjectRepository(RoomMembership)
    private readonly membershipRepo: Repository<RoomMembership>,
    @InjectRepository(Token)
    private readonly tokenRepo: Repository<Token>,
    @InjectRepository(SyncState)
    private readonly syncStateRepo: Repository<SyncState>,
    // The publish queue + RoomAdminsService are WORKER-only collaborators used by
    // {@link flushDueEvictions}. `bufferEvictions` (called from the indexer/main
    // plugins) needs NEITHER, so both are `@Optional()` — the service constructs in
    // main (plugin modules) without the worker-only relay/admin wiring present.
    @Optional()
    @InjectQueue(PUBLISH_NIP29_QUEUE)
    private readonly publishQueue: Queue<PublishNip29Job> | null,
    @Optional()
    private readonly roomAdmins: RoomAdminsService | null,
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
  ) {}

  /**
   * Current chain height = `SyncState.tip_height` (single agreed source, req §6).
   * Returns `null` when the sync-state row is missing/unreadable so callers can
   * skip rather than evict against a bogus height.
   */
  async currentHeight(): Promise<number | null> {
    try {
      const state = await this.syncStateRepo.findOne({
        where: { id: SYNC_STATE_ID },
      });
      const tip = state?.tip_height;
      return typeof tip === 'number' && Number.isFinite(tip) ? tip : null;
    } catch (error: any) {
      this.logger.warn(
        `currentHeight: failed to read SyncState: ${error?.message ?? error}`,
      );
      return null;
    }
  }

  /**
   * Buffer (do NOT publish) the eviction of every member who became ineligible due
   * to a reorg in one of `saleAddresses` (req §6). Called from the plugins'
   * `onReorg` AFTER they recompute desired eligibility (so `room_membership.eligible`
   * already reflects the post-reorg truth).
   *
   * For each affected room, the buffered set = rows that are currently published
   * (`relay_state IN ('added','pending_remove')`) AND now `eligible=false` AND
   * `role <> 'admin'` (admins are never balance-evicted, §6.7). We stamp
   * `held_until_height = currentHeight + TG_REORG_CONFIRMATION_DEPTH_BLOCKS` and pin
   * `relay_state='added'` — the member stays in `39002` (so reconciliation does NOT
   * see it as drift-to-remove, req §8) until the hold passes and the flush confirms
   * the ineligibility. ADDS are never buffered (they flow promptly through Task 10).
   *
   * @returns the number of membership rows buffered for eviction.
   */
  async bufferEvictions(saleAddresses: readonly string[]): Promise<number> {
    const sales = [...new Set((saleAddresses ?? []).filter(Boolean))];
    if (sales.length === 0) {
      return 0;
    }
    const current = await this.currentHeight();
    if (current === null) {
      this.logger.warn(
        'bufferEvictions: no current height (SyncState); skipping buffer',
      );
      return 0;
    }
    const heldUntil = current + this.config.reorgConfirmationDepthBlocks;

    let buffered = 0;
    for (const saleAddress of sales) {
      try {
        // Candidates: published, now-ineligible, non-admin. (An admin row is
        // exempt from balance eviction, §6.7 — Task 08 owns admin convergence.)
        const candidates = await this.membershipRepo.find({
          where: {
            sale_address: saleAddress,
            eligible: false,
            role: Not('admin'),
            relay_state: In(['added', 'pending_remove']),
          },
        });
        for (const row of candidates) {
          await this.membershipRepo.update(
            { id: row.id },
            // Pin back to `added`: the member must remain in `39002` for the whole
            // hold window (a `pending_remove` would otherwise be picked up by the
            // Task 10 publish-pending scan and evicted immediately — the buffer is
            // the whole point). The hold gates the flush, not the relay_state.
            { held_until_height: heldUntil, relay_state: 'added' },
          );
          buffered += 1;
        }
      } catch (error: any) {
        this.logger.error(
          `bufferEvictions(${saleAddress}) failed: ${error?.message ?? error}`,
        );
      }
    }

    if (buffered > 0) {
      this.logger.log(
        `reorg: buffered ${buffered} eviction(s) across ${sales.length} room(s) ` +
          `held_until_height=${heldUntil} (current=${current}, depth=${this.config.reorgConfirmationDepthBlocks})`,
      );
    }
    return buffered;
  }

  /**
   * Buffer evictions for EVERY room that currently has an at-risk member (a
   * published, now-ineligible, non-admin row with no hold yet) — the entry point
   * for the AEX9-transfer plugin's reorg (req §6, modify note). A balance reorg
   * cannot cheaply name the affected sale_addresses (the reverted txs are already
   * deleted and balances were applied additively), so we select the affected rooms
   * by the at-risk membership rows themselves. This is **drift-bounded**, not
   * room-count-bounded: it touches only rows whose `eligible` flipped false and are
   * still published — typically a handful after a reorg, not the ~54k registry. A
   * subsequent balance reconciliation (Task 03) + eligibility recompute (Task 06)
   * keeps the set correct; here we only protect already-ineligible published members
   * from premature eviction during the reorg window.
   *
   * @returns the number of membership rows buffered.
   */
  async bufferAllPendingEvictions(): Promise<number> {
    const rows = await this.membershipRepo
      .createQueryBuilder('m')
      .select('DISTINCT m.sale_address', 'sale_address')
      .where('m.eligible = false')
      .andWhere("m.role <> 'admin'")
      .andWhere("m.relay_state IN ('added','pending_remove')")
      .andWhere('m.held_until_height IS NULL')
      .getRawMany<{ sale_address: string }>();

    const sales = rows.map((r) => r.sale_address).filter(Boolean);
    if (sales.length === 0) {
      return 0;
    }
    return this.bufferEvictions(sales);
  }

  /**
   * Flush evictions whose reorg hold has passed (req §7) — WORKER process (it
   * publishes). Selects `room_membership WHERE held_until_height IS NOT NULL AND
   * held_until_height <= currentHeight AND eligible=false AND role <> 'admin'`; for
   * each due row:
   *   - if it is `eligible=true` again (a follow-up reorg restored it) → CANCEL:
   *     clear `held_until_height`, leave `relay_state` (`added`), publish nothing;
   *   - else enqueue `9001` `removeUser` via `worker:publish-nip29`, flip the row
   *     to `pending_remove`, and clear `held_until_height`. The ACK seam (Task 10
   *     `onPublishAck`) then drives `pending_remove → removed`.
   *
   * The depth gate is enforced by the `held_until_height <= currentHeight`
   * predicate: a removal whose hold has NOT passed is simply not selected (req §7).
   * Adds are never held by this gate.
   *
   * @returns counts of `{ published, cancelled }` for tests/observability.
   */
  async flushDueEvictions(): Promise<{ published: number; cancelled: number }> {
    if (!this.publishQueue) {
      // The flush publishes; it must only run in the worker (where the queue is
      // injected). A main-side caller is a no-op.
      this.logger.warn(
        'flushDueEvictions: no publish queue (not worker mode) — skipping',
      );
      return { published: 0, cancelled: 0 };
    }
    const current = await this.currentHeight();
    if (current === null) {
      this.logger.warn('flushDueEvictions: no current height; skipping flush');
      return { published: 0, cancelled: 0 };
    }

    const limit = this.config.reconcileBatchSize;
    let cursorId = 0;
    let published = 0;
    let cancelled = 0;
    const groupIds = new Map<string, string>();

    for (;;) {
      const due = await this.membershipRepo
        .createQueryBuilder('m')
        .where('m.id > :cursor', { cursor: cursorId })
        .andWhere('m.held_until_height IS NOT NULL')
        .andWhere('m.held_until_height <= :current', { current })
        .andWhere('m.eligible = false')
        .andWhere("m.role <> 'admin'")
        .orderBy('m.id', 'ASC')
        .limit(limit)
        .getMany();

      if (due.length === 0) {
        break;
      }

      for (const row of due) {
        cursorId = Math.max(cursorId, row.id);
        try {
          // Re-confirm at flush time (a reorg may have re-org'd back, req §7).
          const fresh = await this.membershipRepo.findOne({
            where: { id: row.id },
          });
          if (!fresh || fresh.held_until_height === null) {
            continue; // raced with another flush / a cancel
          }
          if (fresh.eligible) {
            // Eligibility restored before the hold passed → cancel the eviction.
            await this.membershipRepo.update(
              { id: fresh.id },
              { held_until_height: null },
            );
            cancelled += 1;
            continue;
          }
          // Still ineligible. A configured admin is never balance-evicted (§6.7) —
          // belt-and-braces over the `role` predicate (handles a moderator whose
          // pubkey is in TG_ROOM_ADMINS but role row not yet promoted).
          if (this.roomAdmins?.isConfiguredAdmin(fresh.member_pubkey)) {
            await this.membershipRepo.update(
              { id: fresh.id },
              { held_until_height: null },
            );
            cancelled += 1;
            continue;
          }
          if (!fresh.member_pubkey) {
            // Nothing to remove on the relay (never published) — just clear hold.
            await this.membershipRepo.update(
              { id: fresh.id },
              { held_until_height: null },
            );
            cancelled += 1;
            continue;
          }

          const groupId = await this.resolveGroupId(
            fresh.sale_address,
            groupIds,
          );
          await this.enqueueRemove(
            groupId,
            fresh.sale_address,
            fresh.member_pubkey,
          );
          // Flip to pending_remove + clear the hold so it is not re-flushed; the
          // Task 10 ACK seam drives pending_remove → removed on the relay ACK.
          await this.membershipRepo.update(
            { id: fresh.id },
            { relay_state: 'pending_remove', held_until_height: null },
          );
          published += 1;
        } catch (error: any) {
          this.logger.error(
            `flushDueEvictions: row ${row.id} (${row.sale_address}) failed: ` +
              `${error?.message ?? error}`,
          );
        }
      }

      if (due.length < limit) {
        break;
      }
    }

    if (published > 0 || cancelled > 0) {
      this.logger.log(
        `reorg flush @${current}: ${published} eviction(s) published, ` +
          `${cancelled} cancelled`,
      );
    }
    return { published, cancelled };
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  /** Resolve + memoize the NIP-29 group id for a sale (D3 verbatim). */
  private async resolveGroupId(
    saleAddress: string,
    cache: Map<string, string>,
  ): Promise<string> {
    const cached = cache.get(saleAddress);
    if (cached) {
      return cached;
    }
    const token = await this.tokenRepo.findOne({
      where: { sale_address: saleAddress },
    });
    const groupId = groupIdFor({
      sale_address: saleAddress,
      nostr_group_id: token?.nostr_group_id,
    });
    cache.set(saleAddress, groupId);
    return groupId;
  }

  /** Enqueue one `9001` remove-user onto `worker:publish-nip29` (Task 07 path). */
  private async enqueueRemove(
    groupId: string,
    saleAddress: string,
    pubkey: string,
  ): Promise<void> {
    if (!this.publishQueue) {
      return;
    }
    await this.publishQueue.add(
      {
        template: removeUser(groupId, pubkey),
        groupId,
        meta: { saleAddress, reason: 'reorg-evict' },
      },
      publishNip29JobOptions(this.config.publishMaxRetries),
    );
  }
}

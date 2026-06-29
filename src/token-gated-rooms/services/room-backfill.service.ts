import { InjectQueue } from '@nestjs/bull';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { IsNull, Repository } from 'typeorm';
import { Token } from '@/tokens/entities/token.entity';
import tgrConfig, { isRelayConfigured } from '../config/tgr.config';
import { CommunityRoom } from '../entities/community-room.entity';
import { RoomBackfillState } from '../entities/room-backfill-state.entity';
import { createGroup, editMetadata, NIP29_KIND } from '../nostr/nip29';
import {
  TGR_COMMUNITY_UPSERTED,
  TGR_GROUP_MISSING,
  TGR_PUBLISH_ACK,
  TGR_ROOM_CREATED,
  type TgrCommunityUpsertedPayload,
  type TgrGroupMissingPayload,
  type TgrPublishAckPayload,
  type TgrRoomCreatedPayload,
} from '../events';
import {
  isLegalNostrRoomStateTransition,
  type NostrRoomState,
} from '../enums/nostr-room-state.enum';
import { publishNip29JobOptions } from '../queues/publish-nip29.job-options';
import { PUBLISH_NIP29_QUEUE } from '../queues/publish-nip29.processor';
import type { PublishNip29Job } from '../queues/publish-nip29.types';
import { RoomAdminsService } from './room-admins.service';
import {
  BACKFILL_KICKOFF_JOB,
  BACKFILL_ON_BOOT_ENV,
  BACKFILL_STALE_SWEEP_JOB,
  parseBool,
  ROOM_BACKFILL_QUEUE,
  ROOM_BACKFILL_STATE_ID,
} from '../queues/room-backfill.constants';
import { GroupMissingTracker } from './group-missing-tracker.service';

/** Outcome of requesting a room for a single token. */
export interface RoomRequestResult {
  saleAddress: string;
  /** Whether `9007`/`9002` were enqueued (a `none|failed → pending` happened). */
  requested: boolean;
  /** The state the token is in after this call. */
  state: NostrRoomState;
}

/** Outcome of one driver page. */
export interface PageResult {
  /** Tokens requested in this page. */
  requested: number;
  /**
   * Keyset cursor to resume from: the last `sale_address` seen in this page. Pass
   * it back to {@link RoomBackfillService.processPage} for the following page.
   * `undefined` when the page was empty.
   */
  nextCursor?: string;
  /** Whether another page may exist (page was full). */
  hasMore: boolean;
}

/**
 * Pure transition decision for a relay publish ACK (§4.7). Given the current
 * state and an ACK for the group-create / edit-metadata publish, returns the next
 * state, or `undefined` for "no change" (e.g. an ACK that doesn't apply).
 *
 * - A `9007` ok ACK (incl. relay `"Group already exists"`, which the processor
 *   maps to ok) is the authoritative "group exists" signal: `pending → created`.
 * - A `9007`/`9002` failure ACK (writer retries exhausted) drives `pending →
 *   failed`.
 * - `created`/`deleted` are not moved by an ACK (idempotent re-publish on a
 *   re-run lands here harmlessly).
 */
export function nextStateForAck(
  from: NostrRoomState,
  kind: number,
  ok: boolean,
): NostrRoomState | undefined {
  if (from === 'deleted' || from === 'created') {
    // Terminal / already-created: a re-publish ACK never regresses these.
    return undefined;
  }
  if (kind === NIP29_KIND.CREATE_GROUP) {
    if (ok && isLegalNostrRoomStateTransition(from, 'created')) {
      return 'created';
    }
    if (!ok && isLegalNostrRoomStateTransition(from, 'failed')) {
      return 'failed';
    }
    return undefined;
  }
  if (kind === NIP29_KIND.EDIT_METADATA) {
    // Metadata is non-authoritative for existence; only a failure (with retries
    // exhausted) demotes a not-yet-created room to `failed`.
    if (
      !ok &&
      from === 'pending' &&
      isLegalNostrRoomStateTransition(from, 'failed')
    ) {
      return 'failed';
    }
    return undefined;
  }
  return undefined;
}

/**
 * Eager room backfill (Task 09, plan §6.2 / §4.7 / §9) — WORKER PROCESS ONLY.
 *
 * Drives a resumable, rate-limited creation of a NIP-29 room for EVERY BCL
 * factory token (D8). It does NOT open a relay socket or publish directly: it
 * enqueues `9007` create-group + `9002` edit-metadata onto the Task 07
 * `worker:publish-nip29` queue, seeds the configured admins via Task 08's
 * {@link RoomAdminsService.seedRoomAdmins}, and advances each token through the
 * `nostr_room_state` machine on the `tgr.publish.ack` seam emitted by the publish
 * processor. The `worker:room-backfill` queue runs under the worker prefix so it
 * never steals `main:` indexer jobs (§9).
 *
 * BOOT SAFETY: the kickoff runs in `onApplicationBootstrap` — the NestJS hook that
 * fires only AFTER every module has finished initializing (DB, queues and the
 * relay writer are all ready), not mid-init like `onModuleInit`. It is still gated
 * behind `TG_BACKFILL_ON_BOOT === 'true'` (default off) so the boot smoke / a
 * relay-less process never start the sweep; otherwise it is triggered explicitly
 * via {@link startBackfill}. Enqueuing ~54k jobs only happens behind that flag.
 *
 * RESUMABILITY: `Token.has_nostr_room` is the per-token source of truth. The
 * working set is re-derived every page from
 * `has_nostr_room = false AND nostr_room_state NOT IN ('created','deleted')`,
 * ordered by `sale_address`, so a restart re-runs at most the in-flight page and
 * no token is double-created (the flag guard + relay `"Group already exists"`
 * make re-runs idempotent). The cursor in `room_backfill_state.batch_offset` is a
 * best-effort progress marker; correctness comes from the predicate, not it.
 */
@Injectable()
export class RoomBackfillService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RoomBackfillService.name);

  /** About string applied to every backfilled room's `9002` edit-metadata. */
  static readonly ROOM_ABOUT = 'Token-gated chat on Superhero.';

  constructor(
    @InjectRepository(Token)
    private readonly tokenRepository: Repository<Token>,
    @InjectRepository(CommunityRoom)
    private readonly communityRoomRepository: Repository<CommunityRoom>,
    @InjectRepository(RoomBackfillState)
    private readonly backfillStateRepository: Repository<RoomBackfillState>,
    @InjectQueue(PUBLISH_NIP29_QUEUE)
    private readonly publishQueue: Queue<PublishNip29Job>,
    @InjectQueue(ROOM_BACKFILL_QUEUE)
    private readonly backfillQueue: Queue,
    private readonly roomAdmins: RoomAdminsService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
    // Optional so the many positional-construction unit tests keep working; the DI
    // container always provides it in the running app.
    @Optional()
    private readonly groupMissing?: GroupMissingTracker,
  ) {}

  /**
   * BOOT-SAFE gate (Task 09): schedule the kickoff ONLY behind
   * `TG_BACKFILL_ON_BOOT=true` (and only when a relay is configured). Runs in
   * `onApplicationBootstrap` (not `onModuleInit`) so the whole app — DB pool,
   * queues, relay writer — is fully up before the sweep enqueues anything. When the
   * flag is off (the default) this is a no-op: nothing is enqueued, so the boot
   * smoke / a relay-less process never start a 54k sweep.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.shouldBackfillOnBoot()) {
      return;
    }
    this.logger.log(
      `${BACKFILL_ON_BOOT_ENV}=true — scheduling eager room backfill`,
    );
    await this.startBackfill();
  }

  /**
   * True iff a relay is configured (`isRelayConfigured`) AND
   * `TG_BACKFILL_ON_BOOT === 'true'`. The eager 54k sweep publishes relay creates,
   * so it requires a relay; it stays opt-in behind the env flag (default off).
   */
  private shouldBackfillOnBoot(): boolean {
    const onBoot = parseBool(process.env[BACKFILL_ON_BOOT_ENV], false);
    return isRelayConfigured(this.config) && onBoot;
  }

  /**
   * Explicit, idempotent kickoff entry point. Enqueues a single
   * {@link BACKFILL_KICKOFF_JOB} (the processor then walks pages, re-enqueueing
   * itself) plus the stale-pending sweep. Safe to call repeatedly — Bull collapses
   * duplicate kickoffs onto an existing run via the fixed `jobId`.
   */
  async startBackfill(): Promise<void> {
    await this.backfillQueue.add(
      BACKFILL_KICKOFF_JOB,
      { afterSaleAddress: undefined },
      {
        jobId: BACKFILL_KICKOFF_JOB,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    await this.backfillQueue.add(
      BACKFILL_STALE_SWEEP_JOB,
      {},
      {
        jobId: BACKFILL_STALE_SWEEP_JOB,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  /**
   * Process one page of the working set and request a room for each token. Used by
   * the processor's kickoff loop. KEYSET pagination by `sale_address` (not numeric
   * OFFSET): each page starts strictly after the previous page's last
   * `sale_address`, so a token already requested THIS pass (now `pending`, still in
   * the working set) is not re-selected, while finished tokens (`created`/`deleted`)
   * simply drop out of the predicate. This is stable under the set shrinking as
   * ACKs land asynchronously — no skipped or duplicated rows within a sweep.
   *
   * @param afterSaleAddress keyset cursor — process tokens with
   *   `sale_address > afterSaleAddress` (omit / empty for the first page).
   */
  async processPage(
    afterSaleAddress?: string,
    batchSize?: number,
  ): Promise<PageResult> {
    const size = batchSize ?? this.config.backfillBatchSize;
    const tokens = await this.workingSetPage(size, afterSaleAddress);

    let requested = 0;
    for (const token of tokens) {
      try {
        const result = await this.requestRoom(token);
        if (result.requested) {
          requested += 1;
        }
      } catch (error: any) {
        this.logger.error(
          `[room-backfill] failed to request room for ${token.sale_address}: ${
            error?.message ?? error
          }`,
        );
        // Leave the token at its current state → re-selected on a later sweep.
      }
    }

    const nextCursor =
      tokens.length > 0 ? tokens[tokens.length - 1].sale_address : undefined;
    const hasMore = tokens.length === size;
    await this.advanceCursor(requested);
    return { requested, nextCursor, hasMore };
  }

  /**
   * The next page of the working set: tokens that still need a room, keyset-paged
   * by `sale_address` after `afterSaleAddress` (§Req 1, deterministic order). The
   * predicate (`has_nostr_room=false AND nostr_room_state NOT IN
   * ('created','deleted')`) is re-derived every page → naturally resumable +
   * idempotent (a restart re-runs at most the in-flight page).
   */
  private async workingSetPage(
    size: number,
    afterSaleAddress?: string,
  ): Promise<Token[]> {
    const qb = this.tokenRepository
      .createQueryBuilder('token')
      .where('token.has_nostr_room = :flag', { flag: false })
      .andWhere('token.nostr_room_state NOT IN (:...done)', {
        done: ['created', 'deleted'],
      })
      // Worth-gate: only tokens with a non-zero market cap AND ≥2 holders are worth
      // a relay room (skip worthless / single-holder tokens).
      .andWhere('token.market_cap > 0')
      .andWhere('token.holders_count >= 2');
    if (afterSaleAddress) {
      qb.andWhere('token.sale_address > :after', { after: afterSaleAddress });
    }
    // Keyset-paginated by `sale_address` for resumability (the eager bulk sweep,
    // off by default). The active, market-cap-prioritized creator is the 5-minute
    // provisioning cron (`provisionRoomlessTokens`, ORDER BY market_cap DESC).
    return qb.orderBy('token.sale_address', 'ASC').limit(size).getMany();
  }

  /** Count of tokens still needing a room (observability / tests). Mirrors the
   * worth-gated working set: non-zero market cap AND ≥2 holders. */
  async pendingCount(): Promise<number> {
    return this.tokenRepository
      .createQueryBuilder('token')
      .where('token.has_nostr_room = :flag', { flag: false })
      .andWhere('token.nostr_room_state NOT IN (:...done)', {
        done: ['created', 'deleted'],
      })
      .andWhere('token.market_cap > 0')
      .andWhere('token.holders_count >= 2')
      .getCount();
  }

  /**
   * Request a NIP-29 room for one token (§Req 2):
   *   1) move `none|failed → pending` (legal-transition guarded), stamp
   *      `nostr_group_id = sale_address` (D3);
   *   2) enqueue `9007` create-group then `9002` edit-metadata (visibility from
   *      `community_room.is_private`, default public when no row — plain `[TG]`);
   *   3) seed the configured admins via Task 08 (do NOT reimplement).
   *
   * Idempotent: a token already `created`/`deleted` is skipped; a re-run of a
   * `pending` token re-enqueues the same publishes (relay collapses them).
   */
  async requestRoom(token: Token): Promise<RoomRequestResult> {
    const saleAddress = token.sale_address;
    if (!saleAddress) {
      throw new Error('requestRoom: token.sale_address is required');
    }

    const from = token.nostr_room_state ?? 'none';
    if (from === 'created' || from === 'deleted') {
      // Terminal / done — never re-enqueue (9008-deleted is terminal at the relay).
      return { saleAddress, requested: false, state: from };
    }
    if (from !== 'none' && from !== 'failed' && from !== 'pending') {
      return { saleAddress, requested: false, state: from };
    }

    // `none|failed → pending`. A `pending` token is re-published in place (no
    // state change) — relay idempotency makes the duplicate `9007`/`9002` a no-op.
    if (from === 'none' || from === 'failed') {
      await this.transition(saleAddress, from, 'pending', {
        nostr_group_id: saleAddress,
      });
    }

    const isPrivate = await this.resolveIsPrivate(saleAddress);

    // 1) create-group (9007) — `h` = sale_address verbatim (D3).
    await this.enqueuePublish(
      createGroup(saleAddress),
      saleAddress,
      'backfill-create-group',
    );
    // 2) edit-metadata (9002) — name=$SYMBOL, about, public|private + closed.
    await this.enqueuePublish(
      editMetadata(saleAddress, {
        name: token.symbol,
        about: RoomBackfillService.ROOM_ABOUT,
        isPrivate,
      }),
      saleAddress,
      'backfill-edit-metadata',
    );
    // 3) seed configured admins (Task 08; idempotent at the relay).
    await this.roomAdmins.seedRoomAdmins(saleAddress);

    return { saleAddress, requested: true, state: 'pending' };
  }

  /**
   * REACTIVE auto-create (token launch). `community-room-state` (main) upserts the
   * `community_room` desired state on a `create_community` tx and emits
   * `tgr.community.upserted`; here (worker responsibilities) we react by requesting
   * the relay room for that token so a NEW token gets its NIP-29 group WITHOUT
   * waiting for the next eager-backfill sweep. `requestRoom` is fully idempotent (a
   * token already `created`/`deleted` is skipped; the relay collapses a duplicate
   * `9007` as "Group already exists"), so this is also safe to fire during the bulk
   * `CommunityRoomBackfillService` pass — every upsert drives its room create.
   *
   * In-process only (EventEmitter2): emitter + this listener share the single
   * process, so a `tgr.community.upserted` reliably drives its `9007` create.
   * Relay-gated: with no relay configured there is nothing to create, so we skip.
   */
  @OnEvent(TGR_COMMUNITY_UPSERTED, { async: true, promisify: true })
  async onCommunityUpserted(
    payload: TgrCommunityUpsertedPayload,
  ): Promise<void> {
    if (!isRelayConfigured(this.config)) {
      return;
    }
    const saleAddress = payload?.saleAddress;
    if (!saleAddress) {
      return;
    }
    try {
      const token = await this.tokenRepository.findOne({
        where: { sale_address: saleAddress },
      });
      if (!token) {
        return;
      }
      await this.requestRoom(token);
    } catch (error: any) {
      const msg = String(error?.message ?? error);
      // The reactive create is a best-effort fast-path; the 5-minute provisioning
      // cron (`CommunityRoomBackfillService`, `room_id IS NULL`) is the reliable
      // backstop. A transient infra blip (Redis "Connection is closed", relay
      // socket reconnecting) is therefore NOT an error here — it self-heals on the
      // next cron tick — so log it at debug to avoid flooding the logs.
      const transient =
        /connection is closed|connection closed|enableofflinequeue|econnrefused|socket closed|not connected|relay (unhealthy|not connected)/i.test(
          msg,
        );
      const line = `[room-backfill] reactive create for ${saleAddress} deferred to cron: ${msg}`;
      if (transient) {
        this.logger.debug(line);
      } else {
        this.logger.error(line);
      }
    }
  }

  /**
   * RECOVER from a relay↔DB desync: the publish processor reported a member/metadata
   * publish failed with `"Group not found"` (the relay has no such group though the
   * DB marks the room created — e.g. the relay's data was reset). Re-create the group
   * so the deferred member adds can resume.
   *
   * Debounced per sale via {@link GroupMissingTracker}: a missing group triggers
   * thousands of failing member adds (one per pending holder), but only the FIRST
   * enqueues the re-create; the rest are coalesced. The `9007`+`9002` go onto the
   * throttled `worker:publish-nip29` queue (no relay I/O on this in-process handler),
   * and admins re-seed via `tgr.room.created` once the `9007` ok-ACKs
   * ({@link onPublishAck}). Relay-gated; a `deleted` room is never re-created.
   */
  @OnEvent(TGR_GROUP_MISSING, { async: true, promisify: true })
  async onGroupMissing(payload: TgrGroupMissingPayload): Promise<void> {
    if (!isRelayConfigured(this.config)) {
      return;
    }
    const saleAddress = payload?.saleAddress;
    if (!saleAddress) {
      return;
    }
    // Debounce: a re-create is already in flight for this group (or it was recently
    // re-created) — coalesce the storm of per-member failures into one re-create.
    if (this.groupMissing?.isMissing(saleAddress)) {
      return;
    }
    this.groupMissing?.markMissing(saleAddress);
    try {
      await this.recreateRoomGroup(saleAddress);
    } catch (error: any) {
      // Allow a retry on the next member-add failure rather than suppressing forever.
      this.groupMissing?.clear(saleAddress);
      this.logger.warn(
        `[room-backfill] re-create for missing group ${saleAddress} failed: ${
          error?.message ?? error
        }`,
      );
    }
  }

  /**
   * Re-publish the `9007` create (+ `9002` metadata) for a room whose relay group
   * vanished. The relay create is idempotent (`"Group already exists"` is a no-op),
   * so this is safe even if the group actually still exists. The DB `nostr_room_state`
   * is left `created` (it should be) — the `9007` ok-ACK re-fires `tgr.room.created`
   * which re-seeds admins + re-adds members.
   */
  async recreateRoomGroup(saleAddress: string): Promise<void> {
    const token = await this.tokenRepository.findOne({
      where: { sale_address: saleAddress },
    });
    if (!token) {
      return;
    }
    // Worth-gate (mirrors the provisioning selection): only re-create a room for a
    // token that still has a non-zero market cap AND ≥2 holders — after a relay wipe
    // we don't want to re-create rooms for tokens that are no longer worth one.
    const hasMarketCap = token.market_cap != null && token.market_cap.gt(0);
    if (!hasMarketCap || (token.holders_count ?? 0) < 2) {
      this.logger.debug(
        `[room-backfill] skip re-create for ${saleAddress}: below worth-gate (market_cap/holders)`,
      );
      return;
    }
    const room = await this.communityRoomRepository.findOne({
      where: { sale_address: saleAddress },
    });
    if (room?.deleted) {
      return;
    }
    const isPrivate = await this.resolveIsPrivate(saleAddress);
    await this.enqueuePublish(
      createGroup(saleAddress),
      saleAddress,
      'recreate-missing-group',
    );
    await this.enqueuePublish(
      editMetadata(saleAddress, {
        name: token.symbol,
        about: RoomBackfillService.ROOM_ABOUT,
        isPrivate,
      }),
      saleAddress,
      'recreate-missing-edit',
    );
    this.logger.log(
      `[room-backfill] group ${saleAddress} missing on relay — re-creating (9007+9002)`,
    );
  }

  /**
   * Drive the state machine on the publish ACK seam (§4.7). The publish processor
   * is the sole ACK emitter; this is the sole consumer that moves
   * `Token.nostr_room_state` for the group-level (`9007`/`9002`) publishes.
   *
   *   - `9007` ok (incl. `"Group already exists"`) → `pending → created`, set
   *     `has_nostr_room=true` + `nostr_room_created_at=now()`, emit
   *     `tgr.room.created`.
   *   - `9007`/`9002` failure (retries exhausted) → `pending → failed`.
   *
   * Member-level ACKs (`9000`/`9001`, which carry a `pubkey`) are NOT this task's
   * concern (Task 10) — ignored here.
   */
  @OnEvent(TGR_PUBLISH_ACK, { async: true, promisify: true })
  async onPublishAck(payload: TgrPublishAckPayload): Promise<void> {
    if (!payload?.saleAddress) {
      return;
    }
    // Group-level publishes only (no member pubkey). 9000/9001 are Task 10.
    if (payload.pubkey) {
      return;
    }
    const kind = payload.kind;
    if (kind !== NIP29_KIND.CREATE_GROUP && kind !== NIP29_KIND.EDIT_METADATA) {
      return;
    }

    // Re-create recovery: a `9007` ok-ACK for a group we flagged missing means the
    // relay re-created it. Clear the suppression and re-fire `tgr.room.created` so
    // members re-add (publishPendingForRoom), admins re-seed, and the subscriber
    // re-subscribes — the room is already `created` in the DB, so the transition
    // logic below is a no-op for it (it never regresses `created`).
    if (
      kind === NIP29_KIND.CREATE_GROUP &&
      payload.ok &&
      this.groupMissing?.isMissing(payload.saleAddress)
    ) {
      this.groupMissing.clear(payload.saleAddress);
      this.emitRoomCreated(payload.saleAddress);
      this.logger.log(
        `[room-backfill] group ${payload.saleAddress} re-created on relay — resuming member adds`,
      );
    }

    const token = await this.tokenRepository.findOne({
      where: { sale_address: payload.saleAddress },
    });
    if (!token) {
      return;
    }

    const from = token.nostr_room_state ?? 'none';
    const to = nextStateForAck(from, kind, payload.ok);
    if (!to || to === from) {
      return;
    }

    if (to === 'created') {
      await this.transition(payload.saleAddress, from, 'created', {
        has_nostr_room: true,
        nostr_room_created_at: new Date(),
        // `room_id` is the CONFIRMED-created marker (= the NIP-29 group id =
        // sale_address). Setting it here makes `room_id IS NULL` ⟺ not-yet-created,
        // the predicate the provisioning cron + buy-listener gate on.
        room_id: payload.saleAddress,
      });
      this.emitRoomCreated(payload.saleAddress);
    } else {
      await this.transition(payload.saleAddress, from, to);
    }
  }

  /**
   * Re-publish `pending` rooms with no ACK for > 24h (§4.7). The relay collapses
   * the duplicate `9007`/`9002` (`"Group already exists"`) so this is safe; the
   * row STAYS `pending` (re-publish is not a state change). Driven by the
   * {@link BACKFILL_STALE_SWEEP_JOB}.
   */
  async sweepStalePending(batchSize?: number): Promise<number> {
    const size = batchSize ?? this.config.backfillBatchSize;

    // A `pending` room that never reached `created` has `nostr_room_created_at`
    // unset. The Token entity has no per-row updated-at, so we re-publish every
    // not-yet-created `pending` row; the relay collapses the duplicate `9007`/
    // `9002` (`"Group already exists"`), so the cost is bounded by that no-op and
    // re-publish is safe (the row STAYS `pending` — not a state change, §4.7).
    const stale = await this.tokenRepository.find({
      where: {
        nostr_room_state: 'pending',
        has_nostr_room: false,
        nostr_room_created_at: IsNull(),
      },
      order: { sale_address: 'ASC' },
      take: size,
    });

    let republished = 0;
    for (const token of stale) {
      try {
        const isPrivate = await this.resolveIsPrivate(token.sale_address);
        await this.enqueuePublish(
          createGroup(token.sale_address),
          token.sale_address,
          'backfill-stale-republish-create',
        );
        await this.enqueuePublish(
          editMetadata(token.sale_address, {
            name: token.symbol,
            about: RoomBackfillService.ROOM_ABOUT,
            isPrivate,
          }),
          token.sale_address,
          'backfill-stale-republish-edit',
        );
        republished += 1;
      } catch (error: any) {
        this.logger.warn(
          `[room-backfill] stale re-publish failed for ${token.sale_address}: ${
            error?.message ?? error
          }`,
        );
      }
    }
    if (republished > 0) {
      this.logger.log(
        `[room-backfill] re-published ${republished} stale pending room(s) (>24h, no ACK)`,
      );
    }
    return republished;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * Resolve `9002` visibility from `community_room.is_private` for the sale.
   * Default PUBLIC when no `community_room` row exists yet (plain `[TG]` token, D8).
   */
  private async resolveIsPrivate(saleAddress: string): Promise<boolean> {
    const room = await this.communityRoomRepository.findOne({
      where: { sale_address: saleAddress },
    });
    return !!room?.is_private;
  }

  /** Enqueue one publish onto `worker:publish-nip29` with the §18 job options. */
  private async enqueuePublish(
    template: PublishNip29Job['template'],
    saleAddress: string,
    reason: string,
  ): Promise<void> {
    await this.publishQueue.add(
      { template, groupId: saleAddress, meta: { saleAddress, reason } },
      publishNip29JobOptions(this.config.publishMaxRetries),
    );
  }

  /**
   * Apply a legal `nostr_room_state` transition with an optional column patch. A
   * conditional UPDATE (`WHERE nostr_room_state = from`) makes the write a no-op
   * if another worker already advanced the row — no double-create. An illegal
   * transition is rejected loudly (the machine is enforced HERE, Task 09).
   */
  private async transition(
    saleAddress: string,
    from: NostrRoomState,
    to: NostrRoomState,
    patch: Partial<Token> = {},
  ): Promise<void> {
    if (!isLegalNostrRoomStateTransition(from, to)) {
      throw new Error(
        `illegal nostr_room_state transition ${from} → ${to} for ${saleAddress}`,
      );
    }
    await this.tokenRepository.update(
      { sale_address: saleAddress, nostr_room_state: from },
      { nostr_room_state: to, ...patch },
    );
  }

  /** Emit `tgr.room.created` (non-blocking, like `live-indexer.service.ts:93`). */
  private emitRoomCreated(saleAddress: string): void {
    const payload: TgrRoomCreatedPayload = { saleAddress };
    this.eventEmitter.emit(TGR_ROOM_CREATED, payload);
  }

  /**
   * Best-effort advance of the single-row progress cursor (§8). Resumability is
   * predicate-driven (a restart re-derives the working set from
   * `has_nostr_room=false …`), so `room_backfill_state.batch_offset` is a
   * cumulative count of requested rooms for OBSERVABILITY only — not a correctness
   * input. (The entity has no string column to persist the keyset `sale_address`
   * cursor; that lives in-flight on the Bull job. Adding such a column is Task 00.)
   */
  private async advanceCursor(requestedThisPage: number): Promise<void> {
    if (requestedThisPage <= 0) {
      return;
    }
    try {
      const prior = await this.cursorOffset();
      await this.backfillStateRepository.upsert(
        { id: ROOM_BACKFILL_STATE_ID, batch_offset: prior + requestedThisPage },
        { conflictPaths: ['id'] },
      );
    } catch (error: any) {
      this.logger.warn(
        `[room-backfill] failed to persist cursor: ${error?.message ?? error}`,
      );
    }
  }

  /** Read the cumulative requested count (0 when unset). Test/observability helper. */
  async cursorOffset(): Promise<number> {
    const row = await this.backfillStateRepository.findOne({
      where: { id: ROOM_BACKFILL_STATE_ID },
    });
    return row?.batch_offset ?? 0;
  }
}

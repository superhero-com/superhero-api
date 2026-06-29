import { InjectQueue } from '@nestjs/bull';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { Repository } from 'typeorm';
import {
  finalizeEvent,
  getPublicKey,
  nip19,
  Relay,
  type Event as NostrEvent,
  type EventTemplate,
  type Filter,
} from 'nostr-tools';
import WebSocket from 'ws';
import { Token } from '@/tokens/entities/token.entity';
import { NotificationRedisService } from '@/notifications/services/notification-redis.service';
import tgrConfig, { isRelayConfigured } from '../config/tgr.config';
import { CommunityRoom } from '../entities/community-room.entity';
import { RoomMembership } from '../entities/room-membership.entity';
import { RoomMessageSeen } from '../entities/room-message-seen.entity';
import { TGR_ROOM_CREATED, type TgrRoomCreatedPayload } from '../events';
import { RoomPreferencesService } from '../services/room-preferences.service';
import {
  ROOM_MESSAGE_NOTIFY_JOB,
  ROOM_NOTIFY_QUEUE,
  roomMessageNotifyJobOptions,
  type RoomMessageNotifyJob,
} from '../queues/room-message-notify.types';
import { ownsGroupId, resolveShardIndex } from './shard';
import { setRelaySubscriberConnected } from '../observability/tgr-metrics';

// nostr-tools' `Relay` reads the global `WebSocket` at connect time (mirror the
// writer). Idempotent — safe at module load; no socket is opened here.
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
  (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
}

/** NIP-29 chat kinds we subscribe to (kind 9 = chat, kind 11 = threaded reply). */
const CHAT_KINDS = [9, 11] as const;

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** Per-room coalescing buffer entry (held only for the open window). */
interface CoalesceEntry {
  count: number;
  sampleEventId: string;
  windowStartedAt: number;
  /** Pubkeys that authored any message in this window (excluded from fan-out). */
  authorPubkeys: Set<string>;
  symbol: string;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Long-lived, sharded Nostr **read** subscriber for `groups_relay` (Task 14, plan
 * §7.1) — **WORKER PROCESS ONLY**.
 *
 * ## What it does
 * Maintains a single relay subscription on chat kinds `9`/`11`, filtered by the
 * `#h` (group-id) tags of every *created* room this shard owns, with NIP-42 AUTH
 * as the relay admin so **private** rooms are readable (`group.rs::can_see_event`
 * requires an authed + authorized reader; the admin satisfies it). For each new
 * message it dedups on `room_message_seen.event_id`, resolves the room, builds the
 * added-members recipient set (minus author, minus muted), coalesces per room over
 * `TG_MSG_COALESCE_WINDOW_SEC`, applies a per-recipient rate cap + a queue-depth
 * circuit breaker, and enqueues one `room-message` job per recipient per flush onto
 * the shared `worker:room-notify` queue (Task 12's processor handles the *unnamed*
 * membership jobs; Task 14's named `room-message` jobs are handled by
 * {@link RoomMessageNotifyProcessor}).
 *
 * ## Reuse / invert the writer
 * Reuses Task 07's connection identity + mechanics verbatim (decode `TG_BOT_NSEC`
 * → relay-admin `sk`/`pubkey`, NIP-42 AUTH via `relay.auth`, reconnect-with-backoff
 * floored at `TG_RELAY_HEALTH_PAUSE_SEC`, pause-on-outage). It opens its OWN socket
 * (separate from the writer's) because a live long-lived subscription must not share
 * the publish socket's lifecycle. It writes NO chain/relay state — read + notify only.
 *
 * ## Boot-safety
 * `onModuleInit` is a no-op unless a relay is configured (`isRelayConfigured`), so
 * with no relay the boot smoke never opens a socket or subscribes. Nothing connects
 * at construction (worker mode removed — see `deworker-plan.md`).
 *
 * ## Sizing model (plan §7.1 — finalize via load test, §18 open question 2)
 * Throughput ≈ `groups × avg_members × msgs/hr`. Fan-out is O(members)/message →
 * the cost driver; coalescing collapses a window's messages to one job per
 * recipient (enqueues ≈ `rooms × recipients / window`, not `messages × recipients`).
 * `shard_count = ceil(throughput / per_shard_cap)` (`TG_SUBSCRIBER_SHARDS`, default 1).
 * Backlog is bounded by the circuit breaker: pause this shard's enqueue when the
 * `worker:room-notify` depth exceeds `TG_ROOM_NOTIFY_DEPTH_BREAK` (default 10000),
 * resume under the low-water mark (half). Per-recipient `TG_MSG_RATE_CAP` caps a
 * chatty multi-room user. Concrete values are finalized by the §14 load test.
 */
@Injectable()
export class RelaySubscriberService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(RelaySubscriberService.name);

  private readonly sk: Uint8Array;
  /** Relay-admin public key (safe to log). */
  readonly pubkey: string;

  /** This instance's shard index (0-based ordinal); 0 in the single-shard default. */
  private readonly shardIndex: number;

  private relay?: Relay;
  private connecting?: Promise<void>;
  private sub?: { close: () => void };
  private healthy = false;
  private shuttingDown = false;
  private started = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private resyncTimer?: ReturnType<typeof setInterval>;

  /** Group ids (this shard's) currently in the live subscription filter. */
  private readonly subscribedGroups = new Set<string>();

  /** Per-room coalescing buffers (sale_address → entry); short-lived. */
  private readonly coalescing = new Map<string, CoalesceEntry>();

  /** Circuit-breaker latch: true while this shard's enqueue path is paused. */
  private breakerOpen = false;

  constructor(
    @InjectRepository(Token)
    private readonly tokenRepo: Repository<Token>,
    @InjectRepository(CommunityRoom)
    private readonly roomRepo: Repository<CommunityRoom>,
    @InjectRepository(RoomMembership)
    private readonly membershipRepo: Repository<RoomMembership>,
    @InjectRepository(RoomMessageSeen)
    private readonly seenRepo: Repository<RoomMessageSeen>,
    private readonly roomPreferences: RoomPreferencesService,
    private readonly redis: NotificationRedisService,
    @InjectQueue(ROOM_NOTIFY_QUEUE)
    private readonly notifyQueue: Queue<RoomMessageNotifyJob>,
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
  ) {
    if (!isRelayConfigured(this.config)) {
      // Relay not configured (worker mode removed — see `deworker-plan.md`): stay
      // dormant. The constructor must still assign the readonly fields, but
      // onModuleInit() returns early so no read subscription is ever opened.
      this.sk = new Uint8Array();
      this.pubkey = '';
      this.shardIndex = 0;
      return;
    }
    // Relay vars ARE set; decode the admin nsec. A SET-but-INVALID nsec must NOT
    // crash the API at boot — degrade to dormant (no read subscription) and log
    // loudly, exactly as if the relay were unconfigured. onModuleInit() gates on
    // `pubkey`.
    const nsec = this.config.nostrBotNsec as string;
    try {
      const decoded = nip19.decode(nsec);
      if (decoded.type !== 'nsec') {
        throw new Error('not an nsec');
      }
      this.sk = decoded.data as Uint8Array;
      this.pubkey = getPublicKey(this.sk);
      this.shardIndex = resolveShardIndex(
        process.env,
        this.config.subscriberShards,
      );
    } catch {
      this.logger.error(
        'TG_BOT_NSEC is set but is not a valid bech32 nsec — relay SUBSCRIBER disabled. ' +
          'The HTTP API + chain indexer still run; fix TG_BOT_NSEC to enable room reads.',
      );
      this.sk = new Uint8Array();
      this.pubkey = '';
      this.shardIndex = 0;
    }
  }

  async onModuleInit(): Promise<void> {
    // Relay-gated: open a read subscription only when a relay is configured AND the
    // admin key is valid (an invalid TG_BOT_NSEC leaves `pubkey` empty — see the
    // constructor). With no relay the service stays dormant (no socket, no resync).
    if (!isRelayConfigured(this.config) || !this.pubkey) {
      return;
    }
    this.started = true;
    // Connect in the BACKGROUND — `onModuleInit` must NOT await the relay: Nest runs
    // init hooks inside `app.init()` and `app.listen()` blocks until they resolve, so
    // a relay that stalls AUTH would hang here and the HTTP server would never start
    // (port never opens). Detached, the server boots immediately; failures converge
    // via `scheduleReconnect()`/`scheduleResync()`. (`authenticate()` is also bounded.)
    void this.subscribeInitial();
  }

  /** Initial connect + subscribe, run detached from bootstrap (see {@link onModuleInit}). */
  private async subscribeInitial(): Promise<void> {
    try {
      await this.ensureConnected();
      await this.refreshSubscription();
      this.scheduleResync();
      this.logger.log(
        `relay subscriber ready: shard ${this.shardIndex}/${this.config.subscriberShards} on ${this.config.nostrRelayUrl} as ${this.shortPk()}`,
      );
    } catch (e) {
      this.logger.error(
        `initial relay subscribe failed (${(e as Error)?.message}); will retry`,
      );
      this.scheduleReconnect();
      // Still arm the resync so the filter converges once the socket recovers.
      this.scheduleResync();
    }
  }

  onApplicationShutdown(): void {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.resyncTimer) {
      clearInterval(this.resyncTimer);
    }
    for (const entry of this.coalescing.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
    }
    this.coalescing.clear();
    try {
      this.sub?.close();
    } catch {
      // already closed
    }
    this.relay?.close();
    this.relay = undefined;
    this.healthy = false;
    setRelaySubscriberConnected(false); // Task 15 observability (additive).
  }

  /** Whether the relay socket is connected + AUTHed (gates processing). */
  isHealthy(): boolean {
    return this.healthy && !!this.relay?.connected;
  }

  // ── room-set / subscription management ─────────────────────────────────────

  /**
   * A NIP-29 group was created + ACKed (Task 09, in-worker). Add it to this
   * shard's subscription filter if it maps to our shard. EventEmitter2 is
   * in-process, so this listener only fires in the worker that emits it.
   */
  @OnEvent(TGR_ROOM_CREATED, { async: true, promisify: true })
  async onRoomCreated(payload: TgrRoomCreatedPayload): Promise<void> {
    if (!this.started) {
      return;
    }
    const gid = payload?.saleAddress;
    if (!gid || !this.ownsGroup(gid) || this.subscribedGroups.has(gid)) {
      return;
    }
    try {
      this.subscribedGroups.add(gid);
      await this.resubscribe();
      this.logger.debug(
        `subscribed new room ${gid} (shard ${this.shardIndex})`,
      );
    } catch (e) {
      this.logger.warn(
        `failed to add room ${gid} to subscription: ${(e as Error)?.message}`,
      );
    }
  }

  /**
   * Re-derive this shard's room set from `Token WHERE nostr_room_state='created'`
   * and, if it changed, re-establish the subscription. Run on boot, on reconnect,
   * and on the periodic resync — convergent + idempotent (relay re-delivers from
   * its own store, dedup keeps it safe).
   */
  async refreshSubscription(): Promise<void> {
    const desired = await this.loadShardGroupIds();
    let changed = desired.size !== this.subscribedGroups.size;
    if (!changed) {
      for (const g of desired) {
        if (!this.subscribedGroups.has(g)) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) {
      return;
    }
    this.subscribedGroups.clear();
    for (const g of desired) {
      this.subscribedGroups.add(g);
    }
    await this.resubscribe();
  }

  /** Load every created room's group id that maps to THIS shard. */
  private async loadShardGroupIds(): Promise<Set<string>> {
    const rows = await this.tokenRepo.find({
      where: { nostr_room_state: 'created' },
      select: ['sale_address', 'nostr_group_id'],
    });
    const set = new Set<string>();
    for (const row of rows) {
      const gid = row.nostr_group_id ?? row.sale_address;
      if (gid && this.ownsGroup(gid)) {
        set.add(gid);
      }
    }
    return set;
  }

  /** True iff this shard owns `gid`. */
  private ownsGroup(gid: string): boolean {
    return ownsGroupId(gid, this.shardIndex, this.config.subscriberShards);
  }

  /**
   * (Re)open the live subscription for the current `subscribedGroups`. Closes any
   * prior sub first. With no rooms yet we open NO sub (the relay would reject an
   * empty `#h` and we'd ingest nothing useful). EOSE is informational — the sub
   * stays live for new events.
   */
  private async resubscribe(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    const relay = await this.ensureConnected();

    try {
      this.sub?.close();
    } catch {
      // already closed
    }
    this.sub = undefined;

    if (this.subscribedGroups.size === 0) {
      return;
    }

    const filter: Filter = {
      kinds: [...CHAT_KINDS],
      '#h': [...this.subscribedGroups],
    };

    this.sub = relay.subscribe([filter], {
      onevent: (event: NostrEvent) => {
        void this.onEvent(event);
      },
      oneose: () => {
        // Informational: backlog drained, keep the sub live for new events.
      },
    });
  }

  /** Schedule the periodic room-set resync (worker-only; idempotent). */
  private scheduleResync(): void {
    if (this.resyncTimer || this.shuttingDown) {
      return;
    }
    const everyMs = Math.max(1, this.config.communityTokenRefreshSec) * 1000;
    this.resyncTimer = setInterval(() => {
      void this.runResyncSafely();
    }, everyMs);
    this.resyncTimer.unref?.();
  }

  private async runResyncSafely(): Promise<void> {
    if (this.shuttingDown || !this.isHealthy()) {
      return;
    }
    try {
      await this.refreshSubscription();
    } catch (e) {
      this.logger.warn(`subscription resync failed: ${(e as Error)?.message}`);
    }
  }

  // ── event router ───────────────────────────────────────────────────────────

  /**
   * Route one incoming kind-9/11 event: extract `h`, DEDUP (record-if-absent in
   * `room_message_seen`), resolve the room, build the recipient set, coalesce, and
   * enqueue. NEVER throws back into the relay callback — a router error must not
   * kill the subscription.
   */
  async onEvent(event: NostrEvent): Promise<void> {
    try {
      const gid = firstHTag(event);
      if (!gid) {
        // No `h` tag → not a group message; drop (don't even dedup).
        return;
      }
      // Defensive: ignore events for groups outside this shard (relay should not
      // serve them given the filter, but a shared admin socket might).
      if (!this.ownsGroup(gid)) {
        return;
      }

      // DEDUP FIRST (§7.1): record event.id; an already-present row ⇒ already
      // processed ⇒ skip the whole fan-out. This precedes routing so a redelivery
      // (reconnect / EOSE replay) is a no-op, AND we keep deduping while the
      // breaker is open so the backlog isn't reprocessed on resume.
      if (!(await this.recordSeen(event.id, gid))) {
        return;
      }

      // Resolve the room AFTER dedup so an unknown/deleted room is still recorded
      // (we never want to reprocess it).
      const room = await this.roomRepo.findOne({
        where: { sale_address: gid },
        select: ['sale_address', 'symbol', 'deleted'],
      });
      if (!room || room.deleted) {
        this.logger.debug(`event for unknown/deleted room ${gid}; dropped`);
        return;
      }

      // Circuit breaker (§7.1): when the notify queue is backed up, pause this
      // shard's ENQUEUE (we already deduped, so a paused message won't reprocess).
      if (await this.isBreakerTripped()) {
        return;
      }

      await this.coalesce(room.sale_address, room.symbol ?? gid, event);
    } catch (e) {
      this.logger.error(
        `onEvent router error for ${event?.id}: ${(e as Error)?.message}`,
        e as Error,
      );
    }
  }

  /**
   * Durable dedup: INSERT `{ event_id, sale_address }`, swallowing the PK conflict.
   * Returns `true` iff this is the FIRST sight of the event (a row was inserted),
   * `false` iff it already existed (skip fan-out).
   */
  private async recordSeen(eventId: string, gid: string): Promise<boolean> {
    try {
      const result = await this.seenRepo
        .createQueryBuilder()
        .insert()
        .into(RoomMessageSeen)
        .values({ event_id: eventId, sale_address: gid })
        .orIgnore()
        .returning(['event_id'])
        .execute();
      // `INSERT … ON CONFLICT DO NOTHING RETURNING event_id` yields one row on a
      // fresh insert and ZERO rows when the PK already existed (verified on PG) →
      // `raw.length` is the durable first-sight signal.
      return (result.raw?.length ?? 0) > 0;
    } catch (e) {
      // A unique-violation race lands here on some drivers → treat as "already
      // seen" (safe: another delivery already owns the fan-out).
      this.logger.debug(
        `dedup insert for ${eventId} treated as already-seen: ${(e as Error)?.message}`,
      );
      return false;
    }
  }

  // ── coalescing + fan-out + enqueue ─────────────────────────────────────────

  /**
   * Per-room coalescing (§4, window `TG_MSG_COALESCE_WINDOW_SEC`). The first message
   * in a room opens a window and arms a flush timer; subsequent messages within
   * the window only bump the count. On flush, fan out to recipients ONCE. A window
   * of `0` disables coalescing (flush immediately).
   */
  private async coalesce(
    saleAddress: string,
    symbol: string,
    event: NostrEvent,
  ): Promise<void> {
    const windowSec = this.config.msgCoalesceWindowSec;
    if (windowSec <= 0) {
      await this.flush(saleAddress, {
        count: 1,
        sampleEventId: event.id,
        windowStartedAt: nowSec(),
        authorPubkeys: new Set(event.pubkey ? [event.pubkey] : []),
        symbol,
      });
      return;
    }

    const existing = this.coalescing.get(saleAddress);
    if (existing) {
      existing.count += 1;
      existing.sampleEventId = event.id;
      if (event.pubkey) {
        existing.authorPubkeys.add(event.pubkey);
      }
      return;
    }

    const entry: CoalesceEntry = {
      count: 1,
      sampleEventId: event.id,
      windowStartedAt: nowSec(),
      authorPubkeys: new Set(event.pubkey ? [event.pubkey] : []),
      symbol,
    };
    entry.timer = setTimeout(() => {
      this.coalescing.delete(saleAddress);
      void this.flush(saleAddress, entry).catch((e) =>
        this.logger.error(
          `coalesce flush failed for ${saleAddress}: ${(e as Error)?.message}`,
        ),
      );
    }, windowSec * 1000);
    entry.timer.unref?.();
    this.coalescing.set(saleAddress, entry);
  }

  /**
   * Flush a coalesced window: read the recipient set (added members, minus every
   * member whose `member_pubkey` authored a message in the window), re-read from
   * Postgres so we never hold a stale cache. Per recipient: room-scoped mute gate
   * (Task 12) + per-recipient rate cap, then enqueue one coalesced job.
   */
  private async flush(
    saleAddress: string,
    entry: CoalesceEntry,
  ): Promise<void> {
    // Re-check the breaker at flush time too (depth may have crossed while the
    // window was open) — but we already deduped, so a skipped flush won't reprocess.
    if (await this.isBreakerTripped()) {
      return;
    }

    const recipients = await this.recipientsFor(
      saleAddress,
      entry.authorPubkeys,
    );
    for (const recipient of recipients) {
      try {
        // Mute gate (per-room OR type-level), cheap-first on the hot path.
        const enabled = await this.roomPreferences.isRoomEnabled(
          recipient,
          'room-messages',
          saleAddress,
        );
        if (!enabled) {
          continue;
        }
        // Per-recipient rate cap across rooms.
        if (await this.isRateCapped(recipient)) {
          continue;
        }
        await this.notifyQueue.add(
          ROOM_MESSAGE_NOTIFY_JOB,
          {
            sale_address: saleAddress,
            recipient,
            symbol: entry.symbol,
            message_count: entry.count,
            window_started_at: entry.windowStartedAt,
            sample_event_id: entry.sampleEventId,
          },
          roomMessageNotifyJobOptions(),
        );
      } catch (e) {
        this.logger.warn(
          `enqueue room-message for ${recipient} in ${saleAddress} failed: ${(e as Error)?.message}`,
        );
      }
    }
  }

  /**
   * The notify-eligible recipients for a room: `room_membership WHERE
   * sale_address=gid AND relay_state='added'`, minus any member whose
   * `member_pubkey` is in `authorPubkeys` (excludes message authors). Returns
   * distinct æ addresses.
   */
  private async recipientsFor(
    saleAddress: string,
    authorPubkeys: Set<string>,
  ): Promise<string[]> {
    const rows = await this.membershipRepo.find({
      where: { sale_address: saleAddress, relay_state: 'added' },
      select: ['member_address', 'member_pubkey'],
    });
    const out: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row.member_address || seen.has(row.member_address)) {
        continue;
      }
      // Exclude any member who authored a message in this window.
      if (row.member_pubkey && authorPubkeys.has(row.member_pubkey)) {
        continue;
      }
      seen.add(row.member_address);
      out.push(row.member_address);
    }
    return out;
  }

  // ── circuit breaker + rate cap ─────────────────────────────────────────────

  /**
   * Circuit breaker (§7.1): trip when `worker:room-notify` depth (waiting+delayed)
   * exceeds `TG_ROOM_NOTIFY_DEPTH_BREAK`; resume once it drops below the low-water
   * mark (half). Latched so we don't flap. Fail-open on a probe error.
   */
  private async isBreakerTripped(): Promise<boolean> {
    try {
      const counts = await this.notifyQueue.getJobCounts();
      const depth = (counts.waiting ?? 0) + (counts.delayed ?? 0);
      const high = this.config.roomNotifyDepthBreak;
      const low = Math.floor(high / 2);
      if (this.breakerOpen) {
        if (depth <= low) {
          this.breakerOpen = false;
          this.logger.log(
            `room-notify depth ${depth} ≤ ${low}; circuit breaker reset (shard ${this.shardIndex})`,
          );
        }
      } else if (depth >= high) {
        this.breakerOpen = true;
        this.logger.warn(
          `room-notify depth ${depth} ≥ ${high}; circuit breaker tripped — pausing enqueue (shard ${this.shardIndex})`,
        );
      }
      return this.breakerOpen;
    } catch (e) {
      this.logger.warn(
        `room-notify depth probe failed — failing open: ${(e as Error)?.message}`,
      );
      return false;
    }
  }

  /**
   * Per-recipient fixed-window rate cap (§6, `TG_MSG_RATE_CAP`). Off when
   * `TG_MSG_RATE_CAP=0` (default). Over-cap enqueues are dropped (and counted via the
   * warn log). Fail-open on a Redis blip.
   */
  private async isRateCapped(recipient: string): Promise<boolean> {
    const cap = this.config.msgRateCap;
    if (cap <= 0) {
      return false;
    }
    const windowSec = Math.max(1, this.config.msgCoalesceWindowSec || 60);
    try {
      const { capped } = await this.redis.incrementWithCap(
        `tgr:msg-notify:rate:${recipient}`,
        windowSec,
        cap,
      );
      if (capped) {
        this.logger.warn(
          `room-message rate cap hit for ${recipient} (${cap}/${windowSec}s) — dropping until window resets`,
        );
      }
      return capped;
    } catch (e) {
      this.logger.warn(
        `room-message rate-cap check failed for ${recipient} — failing open: ${(e as Error)?.message}`,
      );
      return false;
    }
  }

  // ── connection lifecycle (mirror RelayWriterService) ───────────────────────

  /** Connect (and AUTH) if not already; returns the live relay. Idempotent. */
  private async ensureConnected(): Promise<Relay> {
    if (this.relay?.connected && this.healthy) {
      return this.relay;
    }
    if (!this.connecting) {
      this.connecting = this.openConnection().finally(() => {
        this.connecting = undefined;
      });
    }
    await this.connecting;
    if (!this.relay) {
      throw new Error('relay not connected');
    }
    return this.relay;
  }

  private async openConnection(): Promise<void> {
    const url = this.config.nostrRelayUrl;
    if (!url) {
      throw new Error('TG_RELAY_URL is required in worker mode');
    }

    let relay: Relay;
    try {
      // Bound the WS connect: a host that accepts the TCP socket but never completes
      // the WebSocket upgrade (a half-open/non-relay listener) would otherwise leave
      // `Relay.connect()` pending forever. A timeout lets `ensureConnected()` settle
      // so the reconnect/backoff loop can recover instead of wedging.
      relay = await this.withTimeout(
        Relay.connect(url),
        this.config.publishAckTimeoutMs,
      );
    } catch (e) {
      const reason = typeof e === 'string' ? e : (e as Error)?.message;
      throw new Error(`failed to connect to ${url} (${reason})`);
    }

    relay.onclose = (): void => {
      if (this.shuttingDown) {
        return;
      }
      this.logger.warn('relay subscription closed; scheduling reconnect');
      this.markUnhealthy('socket closed');
      this.sub = undefined;
      this.scheduleReconnect();
    };
    relay.onnotice = (msg: string): void => {
      this.logger.debug(`relay NOTICE: ${msg}`);
    };

    this.relay = relay;

    // NIP-42 AUTH as relay admin so private-room chat is served.
    await this.authenticate(relay);

    this.healthy = true;
    this.reconnectAttempts = 0;
    setRelaySubscriberConnected(true); // Task 15 observability (additive).
  }

  /**
   * Respond to the relay's NIP-42 AUTH challenge with a signed kind-22242 (mirror
   * RelayWriterService.authenticate). No-op if the relay never challenges.
   */
  private async authenticate(relay: Relay): Promise<void> {
    try {
      // Bound the AUTH: `relay.auth()` blocks until the relay sends a NIP-42
      // challenge, but groups_relay only challenges on a protected REQ — so without
      // a timeout this awaits forever and hangs the connect. A timeout is benign:
      // the relay re-challenges on the next protected read.
      await this.withTimeout(
        relay.auth(async (evt: EventTemplate) => finalizeEvent(evt, this.sk)),
        this.config.publishAckTimeoutMs,
      );
      this.logger.debug('NIP-42 authenticated as relay admin (subscriber)');
    } catch (e) {
      this.logger.debug(
        `NIP-42 auth skipped/failed: ${(e as Error)?.message ?? e}`,
      );
    }
  }

  /**
   * Reject `p` if it hasn't settled within `ms` (the subscriber has no shared
   * publish helper, so this is a local bound for the AUTH step). The timer is
   * `.unref()`ed so it never keeps the process alive.
   */
  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out after ${ms}ms`)),
        ms,
      );
      timer.unref?.();
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  private markUnhealthy(reason: string): void {
    if (this.healthy) {
      this.logger.warn(`relay subscriber unhealthy: ${reason}`);
    }
    this.healthy = false;
    setRelaySubscriberConnected(false); // Task 15 observability (additive).
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) {
      return;
    }
    this.reconnectAttempts += 1;
    // Capped exponential backoff, floored at the health-pause window (§1, shared
    // with the writer) so we never hammer a dead relay.
    const base = Math.max(1, this.config.relayHealthPauseSec) * 1000;
    const delay = Math.min(
      base * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5)),
      5 * 60 * 1000,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    try {
      this.sub?.close();
    } catch {
      // ignore
    }
    this.sub = undefined;
    try {
      this.relay?.close();
    } catch {
      // ignore
    }
    this.relay = undefined;
    try {
      await this.ensureConnected();
      // On reconnect, RE-ESTABLISH every subscription from the durable room set
      // (§1.1): re-derive from Postgres so we never miss a room created while down.
      await this.refreshSubscriptionForce();
      this.logger.log('relay subscriber reconnected + resubscribed');
    } catch (e) {
      this.logger.warn(
        `relay subscriber reconnect failed (${(e as Error)?.message}); retrying`,
      );
      this.scheduleReconnect();
    }
  }

  /** Force a full re-derive + resubscribe (used on reconnect). */
  private async refreshSubscriptionForce(): Promise<void> {
    const desired = await this.loadShardGroupIds();
    this.subscribedGroups.clear();
    for (const g of desired) {
      this.subscribedGroups.add(g);
    }
    await this.resubscribe();
  }

  private shortPk(): string {
    return this.pubkey.slice(0, 8);
  }
}

/** Extract the first `["h", gid]` tag's value (verbatim). Undefined if absent. */
export function firstHTag(event: { tags?: string[][] }): string | undefined {
  const tags = event?.tags ?? [];
  for (const tag of tags) {
    if (tag[0] === 'h' && typeof tag[1] === 'string' && tag[1].length > 0) {
      return tag[1];
    }
  }
  return undefined;
}

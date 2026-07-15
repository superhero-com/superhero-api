import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import {
  finalizeEvent,
  getPublicKey,
  nip19,
  Relay,
  type Event as NostrEvent,
  type EventTemplate,
} from 'nostr-tools';
import WebSocket from 'ws';
import tgrConfig, { isRelayConfigured } from '../config/tgr.config';
import type { Nip29Template } from './nip29';
import type { PublishResult, RelayWriter } from './relay-writer.contract';
import {
  incrementPublishFailed,
  incrementPublishOk,
  incrementRelayReconnect,
  setRelayWriterConnected,
} from '../observability/tgr-metrics';

export { PublishResult, RelayWriter } from './relay-writer.contract';
export { RELAY_WRITER } from './relay-writer.contract';

// nostr-tools' `Relay` reads the global `WebSocket` at connect time. Node 21+
// ships one, but install the `ws` implementation when missing so the worker
// runs on older runtimes too. Idempotent — safe at module load.
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
  (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

/**
 * Steady-state reconnect cadence under a SUSTAINED relay outage (10 min). The
 * capped-exponential backoff ramps from `relayHealthPauseSec` up to this, so a
 * blip recovers fast while a long outage retries quietly every ~10 min instead of
 * crashing the API or flooding the logs.
 */
const RELAY_RECONNECT_MAX_MS = 10 * 60 * 1000;

/** Relay-served `39002` member kind we read for `fetchGroupMembers`. */
const KIND_GROUP_MEMBERS = 39002;

/**
 * Long-lived, relay-admin-authed write client for `groups_relay` (Task 07 §1).
 *
 * WORKER PROCESS ONLY. Holds the single connection through which every NIP-29
 * publish flows (the `publish-nip29` processor is the sole producer). It owns:
 *   - connect + NIP-42 AUTH as the relay admin (`TG_BOT_NSEC` → admin pubkey),
 *   - reconnect-with-backoff + an `isHealthy()` gate (the processor pauses the
 *     queue while unhealthy rather than burning retries),
 *   - `publish(template)` finalize+sign+publish that waits for the relay ACK up
 *     to `publishAckTimeoutMs` and distinguishes ok / reject / timeout,
 *   - `fetchGroupMembers(groupId)` one-shot `39002` read (for Task 11).
 *
 * It holds NO desired-state and NO membership cache — idempotency is relay-owned
 * (§6.3). The nsec is decoded once and NEVER logged (only the pubkey is).
 */
@Injectable()
export class RelayWriterService
  implements RelayWriter, OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(RelayWriterService.name);

  private readonly sk: Uint8Array;
  /** Bot/relay-admin public key (safe to log). */
  readonly pubkey: string;

  private relay?: Relay;
  private connecting?: Promise<void>;
  private healthy = false;
  private shuttingDown = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private healthWatchdog?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
  ) {
    if (!isRelayConfigured(this.config)) {
      // Relay not configured (worker mode removed — see `deworker-plan.md`): stay
      // dormant. Assign placeholder keys; onModuleInit() opens no socket and
      // isHealthy() stays false, so the publish queue never drains. Nothing
      // enqueues publishes when the relay is unconfigured anyway.
      this.sk = new Uint8Array();
      this.pubkey = '';
      return;
    }
    // Relay vars ARE set; decode the admin nsec. A SET-but-INVALID nsec must NOT
    // crash the API at boot — degrade to dormant (publish nothing) and log loudly,
    // exactly as if the relay were unconfigured. onModuleInit() gates on `pubkey`.
    const nsec = this.config.nostrBotNsec as string;
    try {
      const decoded = nip19.decode(nsec);
      if (decoded.type !== 'nsec') {
        throw new Error('not an nsec');
      }
      this.sk = decoded.data;
      this.pubkey = getPublicKey(this.sk);
    } catch {
      this.logger.error(
        'TG_BOT_NSEC is set but is not a valid bech32 nsec — relay WRITER disabled. ' +
          'The HTTP API + chain indexer still run; fix TG_BOT_NSEC to enable NIP-29 publishing.',
      );
      this.sk = new Uint8Array();
      this.pubkey = '';
    }
  }

  async onModuleInit(): Promise<void> {
    // Relay-gated: dormant unless a relay is configured AND the admin key is valid
    // (an invalid TG_BOT_NSEC leaves `pubkey` empty — see the constructor).
    if (!isRelayConfigured(this.config) || !this.pubkey) {
      return;
    }
    // Connect in the BACKGROUND — `onModuleInit` must NOT await the relay, because
    // Nest runs init hooks inside `app.init()` and `app.listen()` blocks until they
    // all resolve. A relay that accepts the socket but never completes NIP-42 AUTH
    // would hang `ensureConnected()` here with no timeout, and the HTTP API +
    // indexer would never start (port never opens). Firing it detached lets the
    // server boot immediately; connect failures/hangs converge via
    // `scheduleReconnect()` + the health watchdog. (`authenticate()` is also bounded
    // by a timeout so the connect always settles and can recover.)
    void this.connectInitial();
    this.startHealthWatchdog();
  }

  /** Initial relay connect, run detached from bootstrap (see {@link onModuleInit}). */
  private async connectInitial(): Promise<void> {
    try {
      await this.ensureConnected();
      this.logger.log(
        `relay writer ready: ${this.config.nostrRelayUrl} as bot ${this.shortPk()}`,
      );
    } catch (e) {
      this.logger.error(
        `initial relay connect failed (${(e as Error)?.message}); will retry`,
      );
      this.scheduleReconnect();
    }
  }

  /**
   * Safety net against a wedged-unhealthy writer. `healthy` can be flipped false
   * without a socket-close (e.g. a publish ACK timeout), and when the publish queue
   * is paused there are no publishes to drive a recovery — so nothing would ever
   * call `scheduleReconnect` and the writer would stay unhealthy forever (queue
   * permanently paused). This periodic check forces a reconnect whenever we're
   * unhealthy with no reconnect already in flight, so health always recovers on its
   * own. `.unref()` so it never keeps the process alive.
   */
  private startHealthWatchdog(): void {
    const everyMs = Math.max(1, this.config.relayHealthPauseSec) * 1000;
    this.healthWatchdog = setInterval(() => {
      if (
        this.shuttingDown ||
        this.isHealthy() ||
        this.connecting ||
        this.reconnectTimer
      ) {
        return;
      }
      this.logger.warn(
        'relay writer unhealthy with no reconnect pending — forcing reconnect',
      );
      this.scheduleReconnect();
    }, everyMs);
    this.healthWatchdog.unref?.();
  }

  onApplicationShutdown(): void {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.healthWatchdog) {
      clearInterval(this.healthWatchdog);
      this.healthWatchdog = undefined;
    }
    this.relay?.close();
    this.relay = undefined;
    this.healthy = false;
    setRelayWriterConnected(false); // Task 15 observability (additive).
  }

  /** Whether the relay socket is connected + AUTHed (gates the queue). */
  isHealthy(): boolean {
    return this.healthy && !!this.relay?.connected;
  }

  /**
   * Finalize+sign+publish a template and wait for the relay ACK up to
   * `publishAckTimeoutMs`. Resolves a discriminated result; NEVER throws on a
   * relay-level reject/timeout (the processor decides retry vs. terminal vs.
   * already-exists from the reason string).
   */
  async publish(template: Nip29Template): Promise<PublishResult> {
    const relay = await this.ensureConnected();
    const event = finalizeEvent(
      {
        kind: template.kind,
        created_at: nowSec(),
        tags: template.tags,
        content: template.content ?? '',
      },
      this.sk,
    );

    try {
      // nostr-tools' relay.publish() resolves with the relay reason on OK:true
      // and rejects with the reason on OK:false; it has its own publishTimeout
      // (set to ours on connect) but we also race a hard timeout to classify a
      // missing ACK distinctly from a rejection.
      await this.withTimeout(
        relay.publish(event as NostrEvent),
        this.config.publishAckTimeoutMs,
      );
      incrementPublishOk(); // Task 15 observability (additive, no behavior change).
      return { ok: true, id: event.id };
    } catch (e) {
      const timedOut = e instanceof PublishTimeoutError;
      // Task 15 observability (additive): count the failure (+ ACK timeout when
      // it was a timeout — handled inside incrementPublishFailed).
      incrementPublishFailed(timedOut);
      if (timedOut) {
        // No ACK in the window: the relay may be wedged — mark unhealthy so the
        // processor pauses rather than retry-spinning against a dead socket.
        // CRUCIAL: also schedule a reconnect. A publish ACK timeout does NOT close
        // the socket, so `onclose` never fires — without this, `healthy` would stay
        // false forever (the socket looks "connected" but we've flagged it down),
        // which permanently pauses the publish queue. Reconnecting restores health
        // within the backoff window so the queue resumes.
        this.markUnhealthy('publish ACK timeout');
        this.scheduleReconnect();
      }
      const reason =
        typeof e === 'string' ? e : ((e as Error)?.message ?? 'publish failed');
      return { ok: false, id: event.id, reason, timedOut };
    }
  }

  /**
   * One-shot read of a group's current members from the relay-signed `39002`
   * (Task 07 §1.5). Issues a `REQ` for `kinds:[39002]` `#d:[groupId]`, collects
   * the `["p", …]` pubkeys, awaits EOSE, then closes the sub. NOT a live
   * subscription (the kind-9/11 message subscriber is Task 14). Task 11 calls
   * this instead of opening its own connection.
   */
  async fetchGroupMembers(groupId: string): Promise<Set<string>> {
    const relay = await this.ensureConnected();
    const members = new Set<string>();

    return await new Promise<Set<string>>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        try {
          sub.close();
        } catch {
          // already closed
        }
        resolve(members);
      };

      const timer = setTimeout(finish, this.config.publishAckTimeoutMs);
      timer.unref?.();

      const sub = relay.subscribe(
        [{ kinds: [KIND_GROUP_MEMBERS], '#d': [groupId] }],
        {
          onevent: (event: NostrEvent) => {
            // 39002 carries one `p` tag per member; collect them all.
            for (const tag of event.tags) {
              if (tag[0] === 'p' && typeof tag[1] === 'string') {
                members.add(tag[1]);
              }
            }
          },
          oneose: finish,
          onclose: finish,
        },
      );
    });
  }

  // ---- connection lifecycle -------------------------------------------------

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

    // Align the library's per-publish timeout with ours so its internal ACK
    // wait and our `withTimeout` race agree.
    relay.publishTimeout = this.config.publishAckTimeoutMs;

    relay.onclose = (): void => {
      if (this.shuttingDown) {
        return;
      }
      this.logger.warn('relay connection closed; scheduling reconnect');
      this.markUnhealthy('socket closed');
      this.scheduleReconnect();
    };
    relay.onnotice = (msg: string): void => {
      this.logger.debug(`relay NOTICE: ${msg}`);
    };

    this.relay = relay;

    // NIP-42 AUTH as relay admin so the bot can READ private-group state.
    await this.authenticate(relay);

    this.healthy = true;
    this.reconnectAttempts = 0;
    setRelayWriterConnected(true); // Task 15 observability (additive).
  }

  /**
   * Respond to the relay's NIP-42 AUTH challenge with a signed kind-22242. The
   * bot must be the relay admin (D7). No-op if the relay never challenges.
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
      this.logger.debug('NIP-42 authenticated as relay admin');
    } catch (e) {
      // Some relays only challenge on the first protected read; a benign "no
      // challenge" must not flip the connection unhealthy. Real auth failures
      // surface on the next protected REQ.
      this.logger.debug(
        `NIP-42 auth skipped/failed: ${(e as Error)?.message ?? e}`,
      );
    }
  }

  private markUnhealthy(reason: string): void {
    if (this.healthy) {
      this.logger.warn(`relay unhealthy: ${reason}`);
    }
    this.healthy = false;
    setRelayWriterConnected(false); // Task 15 observability (additive).
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) {
      return;
    }
    this.reconnectAttempts += 1;
    incrementRelayReconnect(); // Task 15 observability (additive).
    // Capped exponential backoff: quick early retries recover a transient blip
    // fast, then it settles to a steady ~10-minute cadence under a SUSTAINED relay
    // outage (so we never crash the API and never flood the logs — the relay being
    // offline only means NIP-29 publishing pauses; the HTTP API + indexer keep
    // running). Floored at the health-pause window so we never hammer a dead relay.
    const base = Math.max(1, this.config.relayHealthPauseSec) * 1000;
    const delay = Math.min(
      base * Math.pow(2, this.reconnectAttempts - 1),
      RELAY_RECONNECT_MAX_MS,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, delay);
    // `.unref()` so a pending reconnect backoff (up to RELAY_RECONNECT_MAX_MS)
    // never keeps the process alive — mirrors the equivalent timer in
    // relay-subscriber.service.ts and this file's own healthWatchdog.
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    try {
      this.relay?.close();
    } catch {
      // ignore
    }
    this.relay = undefined;
    try {
      await this.ensureConnected();
      this.logger.log('relay reconnected');
    } catch (e) {
      this.logger.warn(
        `relay reconnect failed (${(e as Error)?.message}); retrying`,
      );
      this.scheduleReconnect();
    }
  }

  private shortPk(): string {
    return this.pubkey.slice(0, 8);
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new PublishTimeoutError(ms)), ms);
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
}

/** Thrown when a publish ACK does not arrive within `publishAckTimeoutMs`. */
export class PublishTimeoutError extends Error {
  constructor(ms: number) {
    super(`relay ACK timed out after ${ms}ms`);
    this.name = 'PublishTimeoutError';
  }
}

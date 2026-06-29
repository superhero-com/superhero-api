import { InjectQueue } from '@nestjs/bull';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Queue } from 'bull';
import tgrConfig from '../config/tgr.config';
import { prefixQueue } from '../config/queue-prefix';
import { TGR_ROOM_CREATED, type TgrRoomCreatedPayload } from '../events';
import { putUser, setRoles } from '../nostr/nip29';
import {
  diffRoomAdmins,
  isConfiguredAdmin as isConfiguredAdminPure,
  parseRoomAdmins,
} from '../nostr/room-admins';
import { RELAY_WRITER, type RelayWriter } from '../nostr/relay-writer.contract';
import { publishNip29JobOptions } from '../queues/publish-nip29.job-options';
import type { PublishNip29Job } from '../queues/publish-nip29.types';

/** Resolved queue name (`worker:publish-nip29`) — the Task 07 durable publish path. */
export const PUBLISH_NIP29_QUEUE = prefixQueue('publish-nip29', 'worker');

/** NIP-29 relay role token for an admin member (`group.rs` `GroupRole::from_str`). */
export const NIP29_ROLE_ADMIN = 'admin';
/** NIP-29 relay role token for a plain member (demotion target in converge). */
export const NIP29_ROLE_MEMBER = 'member';

/**
 * Seeds and maintains the configured `TG_ROOM_ADMINS` set as room admins
 * (`9000` role=admin) in every token-gated room — WORKER PROCESS ONLY (Task 08,
 * D9, plan §6.7).
 *
 * Why a separate provider (not inside the relay writer): the writer is the SOLE
 * consumer of `worker:publish-nip29`; admin seeds are PRODUCED here and flow
 * through that same queue so they inherit the §18 rate-limit / capped-backoff /
 * ACK-timeout discipline (we never call the writer directly to publish). This
 * service composes Task 07's `nip29.ts` builders + the publish queue; it opens NO
 * relay socket of its own.
 *
 * Responsibilities:
 *  - {@link onRoomCreated}: react to `tgr.room.created` (Task 09 ACKs a fresh
 *    group) and seed every configured admin.
 *  - {@link seedRoomAdmins}: idempotent seed (enqueue one `9000` role=admin per
 *    configured admin). Safe to call on create AND on backfill (Task 09) AND on
 *    reconcile — `9000` is relay-replaceable so a re-seed is a relay no-op.
 *  - {@link convergeRoomAdmins}: read-diff-publish for reconciliation (Task 11):
 *    promote configured-not-yet-admin, demote admin-no-longer-configured, never
 *    demoting the bot key (relay last-admin guard, §10).
 *  - {@link isConfiguredAdmin}: the balance-gating exemption predicate Task 10
 *    consumes (a configured admin is never `9001`-removed on balance loss).
 *
 * The configured set is parsed ONCE (fail-fast on a malformed entry) from
 * `config.nostrRoomAdmins`. Empty/unset → rooms get only the bot/creator admin.
 */
@Injectable()
export class RoomAdminsService {
  private readonly logger = new Logger(RoomAdminsService.name);

  /** Configured admins normalized to lowercase 64-hex, parsed once at construct. */
  private readonly configuredAdmins: string[];

  constructor(
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
    @InjectQueue(PUBLISH_NIP29_QUEUE)
    private readonly publishQueue: Queue<PublishNip29Job>,
    @Inject(RELAY_WRITER)
    private readonly relay: RelayWriter,
  ) {
    // Parse + normalize + de-dup once. THROWS on a malformed entry (config error,
    // not a per-room failure) — fail fast at boot.
    this.configuredAdmins = parseRoomAdmins(this.config.nostrRoomAdmins);
    if (this.configuredAdmins.length > 0) {
      this.logger.log(
        `configured room admins: ${this.configuredAdmins.length} pubkey(s)`,
      );
    } else {
      this.logger.log(
        'no TG_ROOM_ADMINS configured; rooms get only the bot/creator admin',
      );
    }
  }

  /** The normalized configured admin hex list (read-only copy). */
  get admins(): readonly string[] {
    return this.configuredAdmins;
  }

  /**
   * Exemption predicate for Task 10: `true` iff `pubkey` (hex/npub) is a
   * configured room admin. Format-insensitive. Owned by this task.
   */
  isConfiguredAdmin(pubkey: string | null | undefined): boolean {
    return isConfiguredAdminPure(pubkey, this.configuredAdmins);
  }

  /**
   * React to a freshly-created/ACKed room (Task 09 emits `tgr.room.created` after
   * the `9007`/`9002` land) and seed the configured admins. Idempotent — a
   * re-emit (e.g. backfill resume) re-enqueues the same `9000`s which the relay
   * treats as no-ops.
   */
  @OnEvent(TGR_ROOM_CREATED, { async: true, promisify: true })
  async onRoomCreated(payload: TgrRoomCreatedPayload): Promise<void> {
    const saleAddress = payload?.saleAddress;
    if (!saleAddress) {
      return;
    }
    await this.seedRoomAdmins(saleAddress);
  }

  /**
   * Enqueue one `9000` put-user (role=admin) per configured admin for
   * `saleAddress`'s group, through `worker:publish-nip29`. Returns the number of
   * publishes enqueued (= configured admin count). No-op (returns 0) when no
   * admins are configured.
   *
   * Idempotent at the relay (`9000` is replaceable) so this is safe to call on
   * create, on Task 09 backfill seeding, and on every reconcile pass.
   */
  async seedRoomAdmins(saleAddress: string): Promise<number> {
    if (!saleAddress || this.configuredAdmins.length === 0) {
      return 0;
    }
    const groupId = this.groupId(saleAddress);
    for (const adminHex of this.configuredAdmins) {
      await this.enqueuePut(groupId, saleAddress, adminHex, 'seed-room-admin');
    }
    this.logger.log(
      `seeded ${this.configuredAdmins.length} admin(s) for room ${saleAddress}`,
    );
    return this.configuredAdmins.length;
  }

  /**
   * Reconcile the relay's CURRENT admin set against the configured set for one
   * room (called by Task 11 every reconciliation pass):
   *  - promote configured-not-yet-admin → `9000` role=admin;
   *  - demote admin-no-longer-configured → `9006` set-roles=member;
   *  - NEVER demote the bot key (creator + relay admin, §10) — keeping it admin
   *    means the relay last-admin guard is not tripped. If a diff would target
   *    the bot key it is filtered out by {@link diffRoomAdmins}; we assert/log if
   *    the converge would otherwise empty the admin set.
   *
   * `currentAdmins` is the relay-served `39001` admin list (hex). Task 11 reads
   * it (it owns the `39001`/`39002` read-back scheduling) and passes it in; when
   * omitted we conservatively fall back to the `39002` member set via the writer
   * (a member present there but not configured is still only DEMOTED, never the
   * bot). Idempotent: equal sets emit no publishes. Returns the enqueued count.
   */
  async convergeRoomAdmins(
    saleAddress: string,
    currentAdmins?: readonly string[],
  ): Promise<number> {
    if (!saleAddress) {
      return 0;
    }
    const groupId = this.groupId(saleAddress);

    // Default to a direct `39002` read via the writer when the caller does not
    // supply the relay's `39001` admin set (Task 11 supplies the real admin list).
    const current =
      currentAdmins ?? Array.from(await this.relay.fetchGroupMembers(groupId));

    const { toPromote, toDemote } = diffRoomAdmins(
      this.configuredAdmins,
      current,
      this.relay.pubkey,
    );

    // Safety: the bot key is always retained admin (§10); a converge that would
    // demote every admin should never happen. Log loudly if it would.
    if (toDemote.length > 0 && toPromote.length === 0) {
      const remaining = new Set(current.map((c) => c.toLowerCase()));
      for (const hex of toDemote) {
        remaining.delete(hex);
      }
      remaining.add((this.relay.pubkey || '').toLowerCase());
      if (remaining.size === 0) {
        this.logger.error(
          `convergeRoomAdmins(${saleAddress}) would remove the sole remaining ` +
            `admin — refusing the demotion set to respect the relay last-admin guard`,
        );
        return 0;
      }
    }

    let enqueued = 0;
    for (const adminHex of toPromote) {
      await this.enqueuePut(groupId, saleAddress, adminHex, 'converge-promote');
      enqueued += 1;
    }
    for (const adminHex of toDemote) {
      await this.enqueueDemote(groupId, saleAddress, adminHex);
      enqueued += 1;
    }

    if (enqueued > 0) {
      this.logger.log(
        `converge room ${saleAddress}: +${toPromote.length} promote, ` +
          `-${toDemote.length} demote`,
      );
    }
    return enqueued;
  }

  // ── publish helpers (enqueue onto worker:publish-nip29) ───────────────────

  /** Enqueue a `9000` put-user role=admin (add/promote). */
  private async enqueuePut(
    groupId: string,
    saleAddress: string,
    adminHex: string,
    reason: string,
  ): Promise<void> {
    const template = putUser(groupId, adminHex, NIP29_ROLE_ADMIN);
    await this.publishQueue.add(
      {
        template,
        groupId,
        meta: { saleAddress, reason },
      },
      publishNip29JobOptions(this.config.publishMaxRetries),
    );
  }

  /** Enqueue a `9006` set-roles=member (demote a no-longer-configured admin). */
  private async enqueueDemote(
    groupId: string,
    saleAddress: string,
    adminHex: string,
  ): Promise<void> {
    const template = setRoles(groupId, adminHex, [NIP29_ROLE_MEMBER]);
    await this.publishQueue.add(
      {
        template,
        groupId,
        meta: { saleAddress, reason: 'converge-demote' },
      },
      publishNip29JobOptions(this.config.publishMaxRetries),
    );
  }

  /**
   * The NIP-29 group id for a room. D3: the group id is `sale_address` verbatim
   * (stored once in `Token.nostr_group_id`); the `tgr.room.created` payload
   * carries only `saleAddress`, so it IS the group id here.
   */
  private groupId(saleAddress: string): string {
    return saleAddress;
  }
}

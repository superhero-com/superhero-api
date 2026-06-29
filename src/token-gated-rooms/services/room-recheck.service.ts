import { InjectQueue } from '@nestjs/bull';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { Repository } from 'typeorm';
import { Token } from '@/tokens/entities/token.entity';
import tgrConfig, { isRelayConfigured } from '../config/tgr.config';
import { CommunityRoom } from '../entities/community-room.entity';
import { RoomMembership } from '../entities/room-membership.entity';
import { RoomViewDto } from '../dto/room.view.dto';
import { groupIdFor } from '../nostr/group-id';
import { putUser } from '../nostr/nip29';
import { RELAY_WRITER, type RelayWriter } from '../nostr/relay-writer.contract';
import { publishNip29JobOptions } from '../queues/publish-nip29.job-options';
import { PUBLISH_NIP29_QUEUE } from '../queues/publish-nip29.processor';
import type { PublishNip29Job } from '../queues/publish-nip29.types';
import { EligibilityService } from './eligibility.service';
import { roomConfirmedCreated } from './membership-sync.service';
import { RoomBackfillService } from './room-backfill.service';

/**
 * On-demand, per-caller room access recheck — backs `POST /rooms/:saleAddress/recheck`.
 *
 * The read API (`GET /rooms`) is a passive, cached DB read: when a holder is stuck
 * on "Setting up your access…", re-reading it just returns the same stale row. This
 * service is the ACTIVE path the client calls to force a recheck. For the caller +
 * room it:
 *
 *  1. **Recomputes eligibility** from the live `token_holder` ledger
 *     ({@link EligibilityService.recomputeMember}) — picks up a just-settled buy +
 *     resolves the Nostr pubkey, so a fresh holder gets a desired-state row.
 *  2. **Reconciles against the relay** (the authoritative member set, when a relay
 *     is configured + healthy):
 *     - **relay-ahead heal:** if the NIP-29 group already exists on the relay
 *       (`39002` non-empty) but the DB never recorded it (`room_id` NULL — e.g. a
 *       group created out-of-band, or a `synchronize` wipe), stamp the token
 *       `created`/`room_id`. This is the desync that strands holders forever (the
 *       normal pipeline only reconciles rooms the DB already thinks are created).
 *     - **caller-present heal:** if the caller's pubkey is already in `39002` but
 *       the DB says `pending_add`, flip it to `added` — they can already post.
 *     - **caller-missing publish:** if the caller is eligible + linked but absent
 *       from `39002`, (re)request the room create if needed and enqueue a `9000`
 *       put-user so the worker adds them.
 *  3. Returns the **refreshed** {@link RoomViewDto} for the caller so the client
 *     unlocks immediately (and should also invalidate its rooms query).
 *
 * Idempotent + safe to spam (rate-limited at the controller): every write is a
 * convergence the system would eventually perform anyway; relay idempotency
 * collapses duplicate `9007`/`9000`.
 */
@Injectable()
export class RoomRecheckService {
  private readonly logger = new Logger(RoomRecheckService.name);

  constructor(
    @InjectRepository(Token)
    private readonly tokenRepo: Repository<Token>,
    @InjectRepository(CommunityRoom)
    private readonly communityRoomRepo: Repository<CommunityRoom>,
    @InjectRepository(RoomMembership)
    private readonly membershipRepo: Repository<RoomMembership>,
    @InjectQueue(PUBLISH_NIP29_QUEUE)
    private readonly publishQueue: Queue<PublishNip29Job>,
    @Inject(RELAY_WRITER)
    private readonly relay: RelayWriter,
    private readonly eligibility: EligibilityService,
    private readonly roomBackfill: RoomBackfillService,
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
  ) {}

  /**
   * Recheck + heal `(address, saleAddress)`. Returns the refreshed caller view, or
   * `null` when the sale address is not a gated room (no `community_room` / token).
   */
  async recheck(
    address: string,
    saleAddress: string,
  ): Promise<RoomViewDto | null> {
    const room = await this.communityRoomRepo.findOne({
      where: { sale_address: saleAddress },
    });
    const token = await this.tokenRepo.findOne({
      where: { sale_address: saleAddress },
    });
    if (!room || !token) {
      return null;
    }

    // 1) Refresh the caller's desired state from current holders (fresh buy + pubkey).
    try {
      await this.eligibility.recomputeMember(room, address);
    } catch (error: any) {
      this.logger.warn(
        `recheck recomputeMember(${saleAddress}, ${address}) failed: ${
          error?.message ?? error
        }`,
      );
    }

    // 2) Relay reconcile — only when a relay is configured AND the writer is
    //    connected (otherwise fetchGroupMembers would fail; we still return the
    //    recomputed DB state below).
    const relayHealthy =
      isRelayConfigured(this.config) &&
      (typeof this.relay.isHealthy !== 'function' || this.relay.isHealthy());
    if (relayHealthy) {
      try {
        await this.reconcileAgainstRelay(token, saleAddress, address);
      } catch (error: any) {
        this.logger.warn(
          `recheck relay reconcile(${saleAddress}, ${address}) failed: ${
            error?.message ?? error
          }`,
        );
      }
    }

    // 3) Return the refreshed caller view.
    const fresh = await this.membershipRepo.findOne({
      where: { sale_address: saleAddress, member_address: address },
    });
    if (!fresh) {
      // Not eligible (no desired-state row) → the client treats this like a room
      // absent from the list (the "acquire the token" gate).
      return null;
    }
    return this.toView(room, fresh);
  }

  /** §2 of {@link recheck}: read the relay member set + converge DB / publish. */
  private async reconcileAgainstRelay(
    token: Token,
    saleAddress: string,
    address: string,
  ): Promise<void> {
    const groupId = groupIdFor({
      sale_address: saleAddress,
      nostr_group_id: token.nostr_group_id,
    });
    const relayMembers = await this.relay.fetchGroupMembers(groupId);

    // relay-ahead heal: group exists on the relay but the DB lost the created marker.
    if (relayMembers.size > 0 && !roomConfirmedCreated(token)) {
      await this.tokenRepo.update(
        { sale_address: saleAddress },
        {
          nostr_room_state: 'created',
          has_nostr_room: true,
          room_id: saleAddress,
          nostr_group_id: token.nostr_group_id ?? saleAddress,
          nostr_room_created_at: token.nostr_room_created_at ?? new Date(),
        },
      );
      this.logger.log(
        `recheck: healed ${saleAddress} → created (group present on relay, DB was behind)`,
      );
    }

    const membership = await this.membershipRepo.findOne({
      where: { sale_address: saleAddress, member_address: address },
    });
    if (!membership?.eligible || !membership.member_pubkey) {
      // Not eligible, or not linked yet → nothing to converge on the relay (the
      // unlinked-but-eligible holder must link first; §6.6).
      return;
    }

    if (relayMembers.has(membership.member_pubkey)) {
      // caller-present heal: already a relay member, DB just hadn't caught up.
      if (membership.relay_state !== 'added') {
        await this.membershipRepo.update(
          { id: membership.id },
          { relay_state: 'added', last_published_at: new Date() },
        );
        this.logger.log(
          `recheck: healed membership ${saleAddress}/${address} → added (present in 39002)`,
        );
      }
      return;
    }

    // caller-missing publish: eligible + linked but absent from the relay → make
    // sure the room exists, then enqueue the put-user. Relay idempotency collapses
    // a duplicate 9007/9000, so this is safe to repeat.
    const fresh = await this.tokenRepo.findOne({
      where: { sale_address: saleAddress },
    });
    if (!roomConfirmedCreated(fresh)) {
      await this.roomBackfill.requestRoom(token);
    }
    await this.publishQueue.add(
      {
        template: putUser(
          groupId,
          membership.member_pubkey,
          membership.role === 'admin' ? 'admin' : undefined,
        ),
        groupId,
        meta: { saleAddress, reason: 'recheck-add' },
      },
      publishNip29JobOptions(this.config.publishMaxRetries),
    );
    this.logger.log(
      `recheck: enqueued 9000 add for ${saleAddress}/${address} (absent from 39002)`,
    );
  }

  /** Map a `community_room` + the caller's membership row to the client DTO. */
  private toView(room: CommunityRoom, m: RoomMembership): RoomViewDto {
    const readable = m.relay_state === 'added' && m.member_pubkey != null;
    return {
      sale_address: room.sale_address,
      token_address: room.token_address,
      symbol: room.symbol,
      is_private: room.is_private,
      min_token_threshold: String(room.min_token_threshold ?? '0'),
      is_community: room.is_community,
      role: m.role,
      relay_state: m.relay_state,
      member_pubkey: m.member_pubkey ?? null,
      readable,
    };
  }
}

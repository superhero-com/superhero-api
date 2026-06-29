/**
 * Canonical in-process event names + payloads for token-gated rooms (plan §5/§7,
 * Shared contracts in tasks/README.md). Emitted/consumed via the global
 * `@nestjs/event-emitter` EventEmitter2 (registered by `mdw-sync` —
 * `EventEmitterModule.forRoot()`), the same mechanism as `LIVE_TX_EVENT`.
 *
 * Payloads are intentionally THIN: they carry the identifying keys only and
 * handlers re-query the desired-state tables. This mirrors `LIVE_TX_EVENT` and
 * keeps emitters cheap + avoids stale snapshots travelling through the bus.
 *
 * This file is the single source of truth for these names — every TGR task
 * imports from here so producers and consumers stay in sync. Do not redefine
 * these strings elsewhere.
 */

/** A BCL community-room desired-state row was created/updated (Task 04). */
export const TGR_COMMUNITY_UPSERTED = 'tgr.community.upserted';
export interface TgrCommunityUpsertedPayload {
  /** `Token.sale_address` — PK of `community_room` and the NIP-29 group id. */
  saleAddress: string;
}

/** An AEX9 balance row changed (Task 03). */
export const TGR_BALANCE_CHANGED = 'tgr.balance.changed';
export interface TgrBalanceChangedPayload {
  tokenAddress: string;
  holderAddress: string;
}

/** A member's eligibility for a room flipped (Task 06). */
export const TGR_ELIGIBILITY_CHANGED = 'tgr.eligibility.changed';
export interface TgrEligibilityChangedPayload {
  saleAddress: string;
  memberAddress: string;
  eligible: boolean;
}

/** A NIP-29 group was created on the relay and ACKed (Task 07/09). */
export const TGR_ROOM_CREATED = 'tgr.room.created';
export interface TgrRoomCreatedPayload {
  saleAddress: string;
}

/**
 * A relay publish for a group reported `"Group not found"` — the relay has no such
 * group though the DB marks the room created (DB↔relay desync, e.g. the relay was
 * reset). The owner re-creates the group (queued `9007`), after which the deferred
 * member adds resume. Emitted by the publish processor; consumed by
 * `RoomBackfillService.onGroupMissing`.
 */
export const TGR_GROUP_MISSING = 'tgr.group.missing';
export interface TgrGroupMissingPayload {
  saleAddress: string;
}

/** A room membership desired-state row changed `relay_state` (Task 10). */
export const TGR_MEMBERSHIP_CHANGED = 'tgr.membership.changed';
export interface TgrMembershipChangedPayload {
  saleAddress: string;
  memberAddress: string;
  /** New `room_membership.relay_state`. */
  relayState: 'pending_add' | 'added' | 'pending_remove' | 'removed';
}

/** An address↔nostr identity link changed (Task 05; from address-links). */
export const TGR_LINK_CHANGED = 'tgr.link.changed';
export interface TgrLinkChangedPayload {
  /** æternity account address whose nostr link was added/removed/changed. */
  address: string;
}

/** A relay publish was ACKed/failed (Task 07 → consumed by 10/15). */
export const TGR_PUBLISH_ACK = 'tgr.publish.ack';
export interface TgrPublishAckPayload {
  saleAddress: string;
  /** member pubkey for membership publishes; omitted for group-level events. */
  pubkey?: string;
  /** NIP-29 kind that was published (9007/9002/9000/9001/...). */
  kind: number;
  ok: boolean;
}

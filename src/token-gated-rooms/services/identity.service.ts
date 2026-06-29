import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigType } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Account } from '@/account/entities/account.entity';
import { RoomMembership } from '../entities/room-membership.entity';
import { TGR_LINK_CHANGED, TgrLinkChangedPayload } from '../events';
import tgrConfig from '../config/tgr.config';
import { normalizePubkey } from '../nostr/pubkey';

/**
 * AE-address ↔ nostr-pubkey resolution for token-gated rooms (Task 05).
 *
 * The single source of the mapping the eligibility (Task 06) and membership-sync
 * (Task 10) pipelines need. It reads the **already-materialized**
 * `Account.links[<provider>]` value (populated reactively + verbatim by
 * `AddressLinksPluginSyncService` — we do NOT re-scan the chain), normalizes it
 * strictly to lowercase 64-hex (`npub`→hex via {@link normalizePubkey}), and
 * keeps an in-memory `address↔pubkey` cache for the hot path.
 *
 * ## Unlinked-but-eligible invariant (plan §6.6 — VERIFIED)
 * Private-room access requires **BOTH** an on-chain balance **AND** a nostr link.
 * An eligible holder with no parseable nostr link MUST be recorded as
 * `eligible=true, member_pubkey=null, relay_state='pending_add'` and is **NEVER
 * published** (no `9000`) and **NEVER removed** (no `9001`). This service owns
 * *writing* the null-pubkey/`pending_add` state; it never advances such a row.
 * Eligibility itself is decided by Task 06; publish/skip by Task 10.
 *
 * ## Validation discipline
 * A `member_pubkey` is only ever written when it passes `HEX64`. If
 * `Account.links[<provider>]` exists but is unparseable, the holder is treated as
 * **unlinked** (member_pubkey nulled) — we never persist a malformed pubkey.
 *
 * Registered `mode: 'shared'`, `export: true` so Tasks 06/10 can inject it.
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  /** Hot-path cache: AE address → normalized hex pubkey. */
  private readonly addressToPubkey = new Map<string, string>();
  /** Hot-path cache: normalized hex pubkey → AE address. */
  private readonly pubkeyToAddress = new Map<string, string>();

  constructor(
    @InjectRepository(Account)
    private readonly accountRepo: Repository<Account>,
    @InjectRepository(RoomMembership)
    private readonly membershipRepo: Repository<RoomMembership>,
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** The `Account.links` key resolved to a nostr pubkey (default `'nostr'`). */
  get provider(): string {
    return this.config.nostrLinkProvider;
  }

  // ── cache maintenance (called by IdentityBackfillService + reactive path) ──

  /**
   * Seed/update both cache directions for a resolved link. Removes any stale
   * reverse entry so a re-link to a different pubkey does not leave a dangling
   * `pubkey→address` mapping. No-op for a malformed pubkey.
   */
  setCacheEntry(address: string, pubkey: string): void {
    const hex = normalizePubkey(pubkey);
    if (!hex) return;
    const previous = this.addressToPubkey.get(address);
    if (previous && previous !== hex) {
      // Only drop the reverse entry if it still points back at this address.
      if (this.pubkeyToAddress.get(previous) === address) {
        this.pubkeyToAddress.delete(previous);
      }
    }
    this.addressToPubkey.set(address, hex);
    this.pubkeyToAddress.set(hex, address);
  }

  /** Forget an address (unlink / unparseable). Clears both directions. */
  clearCacheEntry(address: string): void {
    const previous = this.addressToPubkey.get(address);
    this.addressToPubkey.delete(address);
    if (previous && this.pubkeyToAddress.get(previous) === address) {
      this.pubkeyToAddress.delete(previous);
    }
  }

  /** Test/observability hook: number of cached address→pubkey entries. */
  get cacheSize(): number {
    return this.addressToPubkey.size;
  }

  // ── read API (hot path; cache-first, DB fall-through) ──────────────────────

  /**
   * Resolve an AE address to its normalized hex nostr pubkey, or `null` if the
   * account is unlinked / the stored value is unparseable.
   */
  async getPubkeyForAddress(address: string): Promise<string | null> {
    const cached = this.addressToPubkey.get(address);
    if (cached) return cached;

    const account = await this.accountRepo.findOne({
      where: { address },
      select: ['address', 'links'],
    });
    const hex = normalizePubkey(account?.links?.[this.provider]);
    if (!hex) return null;
    this.setCacheEntry(address, hex);
    return hex;
  }

  /**
   * Reverse lookup: resolve a nostr pubkey (hex or npub) to the AE address whose
   * link normalizes to the same hex, or `null` if none. The input is normalized
   * first so an `npub` and its hex form resolve identically.
   */
  async getAddressForPubkey(pubkey: string): Promise<string | null> {
    const hex = normalizePubkey(pubkey);
    if (!hex) return null;

    const cached = this.pubkeyToAddress.get(hex);
    if (cached) return cached;

    // Cache miss: `links->>provider` may store the hex OR the npub form, so we
    // can't match on the raw value with one query. Narrow with a jsonb key
    // filter (only accounts that linked this provider) then normalize each
    // candidate in memory and compare to the target hex.
    const candidates = await this.accountRepo
      .createQueryBuilder('account')
      .select(['account.address', 'account.links'])
      .where(`account.links ? :provider`, { provider: this.provider })
      .getMany();

    for (const account of candidates) {
      const candidateHex = normalizePubkey(account.links?.[this.provider]);
      if (candidateHex === hex) {
        this.setCacheEntry(account.address, hex);
        return account.address;
      }
    }
    return null;
  }

  // ── reactive re-resolution ────────────────────────────────────────────────

  /**
   * React to an address↔nostr link change. `AddressLinksPluginSyncService` emits
   * `tgr.link.changed` ({@link TGR_LINK_CHANGED}) from its link/unlink handlers
   * (the one-line seam in its scope). We re-read `Account.links[<provider>]`,
   * re-normalize, and update the cache + `room_membership.member_pubkey` for that
   * address across all its rooms.
   *
   * We do NOT re-emit `tgr.link.changed` here: the eligibility service (Task 06,
   * req §6) consumes the SAME event independently and recomputes eligibility,
   * re-reading the resolved pubkey through this service — so a single emit fans
   * out to both consumers. Re-emitting would loop this handler. We also do NOT
   * publish to the relay (Task 10 owns that).
   */
  @OnEvent(TGR_LINK_CHANGED, { async: true, promisify: true })
  async onLinkChanged(payload: TgrLinkChangedPayload): Promise<void> {
    const address = payload?.address;
    if (!address) return;
    // emit:false — this WAS the link event; Task 06 already received it too.
    await this.reresolveAddress(address, { emit: false });
  }

  /**
   * Re-read the link for `address`, update the cache + every `room_membership`
   * row for that member, and (optionally) fan out the re-evaluation signal.
   *
   * Linked  → set `member_pubkey` to the normalized hex on all rows.
   * Unlinked / unparseable → null `member_pubkey` (unlinked invariant: nothing
   * else on the row — eligibility / relay_state — is touched here; Task 06/10
   * apply the invariant downstream).
   *
   * @param options.emit when `true` (default) emit `tgr.link.changed` so the
   *   eligibility pipeline (Task 06) re-evaluates. The `@OnEvent` handler passes
   *   `false` because the originating event already reached Task 06; direct
   *   callers (e.g. a backfill correction) pass the default `true` so the change
   *   still fans out. This satisfies Task 05 req §5 ("trigger membership re-sync")
   *   without redefining the canonical `tgr.eligibility.changed` payload (owned by
   *   Task 06) — see the NOTE in the class doc.
   */
  async reresolveAddress(
    address: string,
    options: { emit?: boolean } = {},
  ): Promise<void> {
    const emit = options.emit ?? true;

    const account = await this.accountRepo.findOne({
      where: { address },
      select: ['address', 'links'],
    });
    const hex = normalizePubkey(account?.links?.[this.provider]);

    if (hex) {
      this.setCacheEntry(address, hex);
    } else {
      this.clearCacheEntry(address);
    }

    // Mirror onto the desired-state ledger for this member across all rooms.
    // Validation discipline: `hex` is HEX64-valid or null — never malformed.
    await this.membershipRepo.update(
      { member_address: address },
      { member_pubkey: hex ?? null },
    );

    if (hex) {
      this.logger.log(`Link resolved: ${address} -> ${hex.slice(0, 8)}…`);
    } else {
      this.logger.log(`Link cleared (unlinked/unparseable): ${address}`);
    }

    if (emit) {
      const payload: TgrLinkChangedPayload = { address };
      this.eventEmitter.emit(TGR_LINK_CHANGED, payload);
    }
  }
}

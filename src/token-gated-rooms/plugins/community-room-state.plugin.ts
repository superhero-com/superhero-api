import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { ConfigType } from '@nestjs/config';
import { In, IsNull, Not, Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { Token } from '@/tokens/entities/token.entity';
import { BasePlugin } from '@/plugins/base-plugin';
import { PluginFilter } from '@/plugins/plugin.interface';
import { LIVE_TX_EVENT, LiveTxEventPayload } from '@/mdw-sync/events';
import { BCL_CONTRACT } from '@/plugins/bcl/config/bcl.config';
import { BCL_FUNCTIONS } from '@/configs/constants';
import { isDatabaseConnectionOrPoolError } from '@/utils/database-issue-logging';
import { CommunityRoom } from '../entities/community-room.entity';
import { RoomStateService } from '../services/room-state.service';
import { ReorgEvictionService } from '../services/reorg-eviction.service';
import { CommunityRoomStateSyncService } from './community-room-state-sync.service';
import tgrConfig from '../config/tgr.config';

/**
 * The `CommunityManagement` event variants that signal a *management-changed*
 * event (verified against `CommunityManagement.aci.json`). On any of them we
 * re-read `get_state()` and upsert — never mutate fields piecemeal from the
 * payload.
 */
export const MANAGEMENT_CHANGED_EVENTS = new Set<string>([
  'ChangeMinimumTokenThreshold',
  'AddModerator',
  'DeleteModerator',
  'MuteUserId',
  'UnmuteUserId',
  'SetOwner',
  'ChangedMetaInfo',
]);

/**
 * Community-room state indexer (Task 04, MAIN process only).
 *
 * Reactively derives `community_room` desired state from two on-chain signals
 * and persists it (NO relay writes — Task 10 consumes `tgr.community.upserted`):
 *
 *  - **community-created**: a BCL `create_community` tx on the factory. Detected
 *    via `LIVE_TX_EVENT` (approach (b) — no change to the BCL plugin): on match,
 *    resolve the `Token` by `sale_address` then `readAndUpsertRoomState`.
 *  - **management-changed**: a `CommunityManagement` contract call whose decoded
 *    log contains one of `MANAGEMENT_CHANGED_EVENTS`. The management address is
 *    NOT in the BCL filter, so we keep a refreshed allowlist of all known
 *    `CommunityManagement` addresses (from `community_room`-mapped tokens),
 *    refreshed on community-created and on a TTL (`communityTokenRefreshSec`,
 *    default 5m). NOTE: Task 03 owns the shared AEX9 community-token allowlist;
 *    this management-address allowlist is a separate, room-state-specific set —
 *    coordinate with Task 03's refresh rather than forking the AEX9 one.
 *
 * Registered as a `BasePlugin` so the reorg service invokes `onReorg`; the batch
 * pipeline is unused here (`filters()` is empty), all reactive work runs off
 * `LIVE_TX_EVENT`.
 */
@Injectable()
export class CommunityRoomStatePlugin
  extends BasePlugin
  implements OnModuleInit
{
  protected readonly logger = new Logger(CommunityRoomStatePlugin.name);
  readonly name = 'community-room-state';
  readonly version = 1;

  /** Allowlist of known `CommunityManagement` addresses → their token sale_address. */
  private managementAllowlist = new Map<string, string>();
  private lastAllowlistRefreshMs = 0;

  constructor(
    @InjectRepository(Tx)
    protected readonly txRepository: Repository<Tx>,
    @InjectRepository(PluginSyncState)
    protected readonly pluginSyncStateRepository: Repository<PluginSyncState>,
    @InjectRepository(Token)
    private readonly tokenRepository: Repository<Token>,
    @InjectRepository(CommunityRoom)
    private readonly communityRoomRepository: Repository<CommunityRoom>,
    private readonly roomStateService: RoomStateService,
    private readonly syncService: CommunityRoomStateSyncService,
    private readonly reorgEviction: ReorgEvictionService,
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
  ) {
    super();
  }

  onModuleInit(): void {
    // Warm the allowlist in the BACKGROUND — do NOT await. `refreshAllowlist`
    // makes sequential on-chain calls (`Contract.initialize` +
    // `get_community_management` against the æternity node) for every community
    // room, and `onModuleInit` is awaited inside `app.init()`, so awaiting here
    // blocks `app.listen()` — the HTTP API never starts — whenever the node is
    // slow/unreachable (observed: boot wedged on the first chain call once any
    // `is_community` room existed). The warm-up is best-effort: the TTL refresh
    // (`maybeRefreshAllowlist`) and the periodic reconcile re-derive the set, and a
    // management tx missed during warm-up self-heals — so a late/failed warm-up
    // never loses data, it only delays recognizing a brand-new management contract.
    void this.refreshAllowlist(true).catch((e) =>
      this.logger.warn(`Initial allowlist refresh failed: ${e?.message ?? e}`),
    );
  }

  startFromHeight(): number {
    return BCL_CONTRACT.startHeight ?? 0;
  }

  /**
   * No batch-pipeline filtering: reactive work is driven by `LIVE_TX_EVENT`
   * (approach (b)) and the resumable backfill, so the indexer never needs to
   * persist/route txs to this plugin. `onReorg` is still wired (it is called for
   * every plugin regardless of `filters()`).
   */
  filters(): PluginFilter[] {
    return [];
  }

  protected getSyncService(): CommunityRoomStateSyncService {
    return this.syncService;
  }

  // ---- Predicate helpers (unit-tested) -------------------------------------

  /** True iff the tx is a `create_community` call on the BCL factory. */
  isCommunityCreatedTx(tx: Partial<Tx>): boolean {
    return (
      tx?.type === 'ContractCallTx' &&
      tx?.function === BCL_FUNCTIONS.create_community &&
      !!tx?.contract_id &&
      tx.contract_id === BCL_CONTRACT.contractAddress
    );
  }

  /** True iff the tx targets a known `CommunityManagement` contract. */
  isManagementContract(tx: Partial<Tx>): boolean {
    return (
      tx?.type === 'ContractCallTx' &&
      !!tx?.contract_id &&
      this.managementAllowlist.has(tx.contract_id)
    );
  }

  // ---- Reactive entry point ------------------------------------------------

  @OnEvent(LIVE_TX_EVENT, { async: true })
  async onLiveTx(tx: LiveTxEventPayload): Promise<void> {
    try {
      await this.maybeRefreshAllowlist();

      if (this.isCommunityCreatedTx(tx)) {
        await this.handleCommunityCreated(tx);
        return;
      }

      if (this.isManagementContract(tx)) {
        await this.handleManagementChanged(tx);
        return;
      }
    } catch (error: any) {
      // A transient DB pool/connection blip (e.g. "timeout exceeded when trying
      // to connect" under a backlog drain) is NOT a real failure here: the
      // resumable backfill re-derives community-created rooms and the periodic
      // state-sync re-reads management changes, so anything skipped self-heals.
      // Log it at WARN (no stack) to avoid scary ERROR spam during load spikes;
      // keep ERROR for genuine logic faults.
      if (isDatabaseConnectionOrPoolError(error)) {
        this.logger.warn(
          `onLiveTx deferred to backfill for ${tx?.hash} (transient DB pressure): ${error?.message ?? error}`,
        );
      } else {
        this.logger.error(
          `onLiveTx failed for ${tx?.hash}: ${error?.message ?? error}`,
          error?.stack,
        );
      }
    }
  }

  /**
   * create_community → resolve the new `Token` and upsert its room.
   *
   * The newly-created token's `sale_address` is NOT on the call tx (the call
   * targets the factory `contract_id`); the BCL plugin creates the `Token` from
   * the same tx and stamps `create_tx_hash = tx.hash`. We resolve by that hash.
   * If the BCL plugin hasn't landed the row yet (it processes the same live tx
   * asynchronously), the resumable backfill picks it up — community-created is
   * never lost.
   */
  private async handleCommunityCreated(tx: Partial<Tx>): Promise<void> {
    const token = tx.hash
      ? await this.tokenRepository.findOne({
          where: { create_tx_hash: tx.hash },
        })
      : null;
    if (!token) {
      this.logger.debug(
        `community-created: token not yet present for tx ${tx.hash}; deferring to backfill`,
      );
      return;
    }
    // Token-create auto-creates the room: readAndUpsertRoomState emits
    // `tgr.community.upserted` on first insert, which the decoupled
    // RoomBackfillService (relay 9007 create) + EligibilityService (member seed)
    // consume. `room_id` is then stamped on the 9007 ok ACK. This is the canonical
    // create path — the provisioning cron / buy-listener only cover retries (the
    // room was never confirmed), so there is NO duplicate listener here.
    await this.roomStateService.readAndUpsertRoomState(token);
    // A new community room means a new management address to watch.
    await this.refreshAllowlist(true);
  }

  /**
   * A call on a known management contract. Decode its log; if it carries a
   * management-changed event, resolve the room by management address and re-read
   * authoritative state. (We never mutate from the event payload.)
   */
  private async handleManagementChanged(tx: Partial<Tx>): Promise<void> {
    const managementAddress = tx.contract_id as string;
    const eventNames = await this.syncService.decodeManagementEventNames(
      managementAddress,
      tx.raw?.log,
    );
    // Decode succeeded with at least one event and none are a management change →
    // skip. If we couldn't decode any events (empty/decode failure) on a KNOWN
    // management contract, re-read defensively: the read is one cheap dry-run and
    // `readAndUpsertRoomState` emits nothing when nothing actually changed.
    const decodedSomething = eventNames.length > 0;
    const isManagementChange = decodedSomething
      ? eventNames.some((n) => MANAGEMENT_CHANGED_EVENTS.has(n))
      : true;
    if (!isManagementChange) {
      return;
    }

    const saleAddress = this.managementAllowlist.get(managementAddress);
    if (!saleAddress) {
      return;
    }
    const token = await this.tokenRepository.findOne({
      where: { sale_address: saleAddress },
    });
    if (!token) {
      this.logger.warn(
        `management-changed: no token for sale_address ${saleAddress}`,
      );
      return;
    }
    await this.roomStateService.readAndUpsertRoomState(token);
  }

  // ---- Allowlist refresh ---------------------------------------------------

  private async maybeRefreshAllowlist(): Promise<void> {
    const ttlMs = (this.config.communityTokenRefreshSec ?? 300) * 1000;
    if (Date.now() - this.lastAllowlistRefreshMs >= ttlMs) {
      await this.refreshAllowlist(false);
    }
  }

  /**
   * Rebuild the management-address allowlist from the `community_room` rows that
   * resolved to a community. We re-derive each room's management address via the
   * factory so the set stays correct without persisting it separately.
   *
   * Kept cheap by only resolving rooms flagged `is_community = true` (the [TG]
   * defaults rows carry no management contract). `force` bypasses the TTL guard.
   */
  async refreshAllowlist(force: boolean): Promise<void> {
    const ttlMs = (this.config.communityTokenRefreshSec ?? 300) * 1000;
    if (!force && Date.now() - this.lastAllowlistRefreshMs < ttlMs) {
      return;
    }
    this.lastAllowlistRefreshMs = Date.now();

    const communityRooms = await this.communityRoomRepository.find({
      where: { is_community: true },
      select: ['sale_address'],
    });
    if (communityRooms.length === 0) {
      return;
    }

    const next = new Map<string, string>();
    for (const room of communityRooms) {
      try {
        const managementAddress = await this.resolveManagement(
          room.sale_address,
        );
        if (managementAddress) {
          next.set(managementAddress, room.sale_address);
        }
      } catch (error: any) {
        this.logger.debug(
          `allowlist: failed to resolve management for ${room.sale_address}: ${error?.message ?? error}`,
        );
      }
    }
    this.managementAllowlist = next;
    this.logger.debug(`allowlist refreshed: ${next.size} management contracts`);
  }

  /** Resolve a management address; delegates to the shared read service. */
  private async resolveManagement(
    saleAddress: string,
  ): Promise<string | undefined> {
    return this.roomStateService.resolveManagementAddress(saleAddress);
  }

  /** Test/introspection helper for the allowlist. */
  getManagementAllowlist(): Map<string, string> {
    return this.managementAllowlist;
  }

  /** Test/introspection helper to seed the allowlist (e.g. unit predicate tests). */
  setManagementAllowlistEntry(
    managementAddress: string,
    saleAddress: string,
  ): void {
    this.managementAllowlist.set(managementAddress, saleAddress);
  }

  // ---- Reorg ---------------------------------------------------------------

  /**
   * Reorg seam (Task 04 req §8; Task 11 buffers evictions, plan §6.5).
   *
   * The reverted txs are already deleted from `txs` at this point, so we resolve
   * the affected `community_room` rows by the create-community tx hash recorded
   * on their `Token` (`create_tx_hash IN removedTxHashes`) and re-derive their
   * authoritative state from live `get_state()` (reorg-safe — we never trust the
   * reverted event payload). An empty / unrelated `removedTxHashes` is a no-op.
   *
   * **Reorg-gated eviction (Task 11 §6):** after recomputing each affected room's
   * desired state, we DO NOT publish removals from here (`onReorg` fires
   * synchronously in the indexer and a transient fork would flap members out of
   * `39002`). Instead we hand the affected sale_addresses to
   * {@link ReorgEvictionService.bufferEvictions}, which stamps `held_until_height`
   * on every now-ineligible non-admin published member and leaves them in `39002`;
   * the worker's scheduled flush publishes the `9001` only once the reorg depth has
   * passed (and cancels the eviction if the member becomes eligible again). ADDS
   * are unaffected — a member who *becomes* eligible flows through the normal Task
   * 06 → Task 10 prompt path.
   */
  async onReorg(removedTxHashes: string[]): Promise<void> {
    if (!removedTxHashes || removedTxHashes.length === 0) {
      return;
    }

    const affectedTokens = await this.tokenRepository.find({
      where: {
        create_tx_hash: In(removedTxHashes),
        sale_address: Not(IsNull()),
      },
    });

    if (affectedTokens.length === 0) {
      this.logger.debug(
        `[${this.name}] reorg: no community rooms affected by ${removedTxHashes.length} removed txs`,
      );
      return;
    }

    this.logger.log(
      `[${this.name}] reorg: recomputing ${affectedTokens.length} affected community room(s)`,
    );
    const affectedSales: string[] = [];
    for (const token of affectedTokens) {
      try {
        await this.roomStateService.readAndUpsertRoomState(token);
        affectedSales.push(token.sale_address);
      } catch (error: any) {
        this.logger.error(
          `[${this.name}] reorg: failed to recompute room ${token.sale_address}: ${error?.message ?? error}`,
        );
      }
    }
    await this.refreshAllowlist(true);

    // Buffer (do NOT publish) any now-ineligible memberships in the affected rooms
    // until the reorg depth passes (Task 11 §6 — prevents membership flapping).
    try {
      await this.reorgEviction.bufferEvictions(affectedSales);
    } catch (error: any) {
      this.logger.error(
        `[${this.name}] reorg: bufferEvictions failed: ${error?.message ?? error}`,
      );
    }
  }
}

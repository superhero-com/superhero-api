import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { BigNumber } from 'bignumber.js';
import { Contract, Encoded } from '@aeternity/aepp-sdk';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { Token } from '@/tokens/entities/token.entity';
import { CommunityRoom } from '../entities/community-room.entity';
import { TGR_COMMUNITY_UPSERTED, TgrCommunityUpsertedPayload } from '../events';
import CommunityFactoryACI from '@/plugins/bcl/contract/aci/CommunityFactory.aci.json';
import CommunityManagementACI from '@/plugins/bcl/contract/aci/CommunityManagement.aci.json';
import { BCL_CONTRACT } from '@/plugins/bcl/config/bcl.config';

type ContractInstance = Awaited<ReturnType<typeof Contract.initialize>>;

type CachedContract = {
  instance: ContractInstance;
  lastUsedAt: number;
};

/**
 * Raw on-chain `CommunityManagement.get_state()` record (verified against
 * `CommunityManagement.aci.json` state record + the bot's
 * `RoomManagementContractState`). `minimum_token_threshold` is a raw base-unit
 * `int`; `moderator_accounts` / `muted_user_ids` decode as JS `Set`s.
 */
export interface CommunityManagementState {
  owner: Encoded.AccountAddress;
  minimum_token_threshold: bigint | number | string;
  is_private: boolean;
  moderator_accounts: Set<string> | string[];
  muted_user_ids: Set<string> | string[];
  meta_info?: unknown;
}

/**
 * Set-diff of two address/string lists: which entries were added vs removed.
 */
export interface SetDiff {
  added: string[];
  removed: string[];
}

/**
 * Rich, self-contained `tgr.community.upserted` payload (plan §5.2, Task 04 req
 * §4). Extends the canonical thin payload from `../events` (which carries only
 * `saleAddress`) with the mapped fields + the computed diff so consumers
 * (eligibility 06, membership-sync 10) never have to re-read the row. The
 * canonical event NAME/key (`saleAddress`) is preserved verbatim; this is a
 * superset, not a redefinition.
 */
export interface TgrCommunityUpsertedDetail extends TgrCommunityUpsertedPayload {
  is_community: boolean;
  is_private: boolean;
  /** Raw base-unit integer, serialized as a decimal string (jsonb-safe). */
  min_token_threshold: string;
  owner_address: string;
  moderators: string[];
  muted: string[];
  deleted: boolean;
  changed: {
    moderators?: SetDiff;
    muted?: SetDiff;
    threshold?: boolean;
    owner?: boolean;
    is_private?: boolean;
  };
}

/**
 * Outcome of a single `readAndUpsertRoomState` call — useful for the backfill
 * service's accounting and for tests.
 */
export interface RoomStateUpsertResult {
  saleAddress: string;
  /** Whether a `tgr.community.upserted` event was emitted (i.e. something changed). */
  emitted: boolean;
  isCommunity: boolean;
  deleted: boolean;
}

/**
 * Canonical read-and-persist path for `community_room` desired state (Task 04).
 *
 * Used by BOTH the reactive plugin (`community-room-state.plugin.ts`, driven by
 * `LIVE_TX_EVENT`) and the resumable backfill. It resolves a token's
 * `CommunityManagement` via the cheap per-key
 * `CommunityFactory.get_community_management(sale)` entrypoint (NEVER the
 * whole-registry getter — it runs out of gas, verified in the bot's
 * `CommunityRoomScanner`), reads `CommunityManagement.get_state()`, maps it onto
 * `community_room`, diffs against the existing row, upserts, and emits
 * `tgr.community.upserted` only when something changed.
 *
 * Contract instances are cached per-address (LRU, max 150) mirroring
 * `BasePluginSyncService.getContract` — the management ACI is shared, only the
 * address varies, so a 54k backfill relies on LRU eviction (no pre-warm).
 */
@Injectable()
export class RoomStateService {
  private readonly logger = new Logger(RoomStateService.name);

  static readonly MAX_CACHED_CONTRACTS = 150;

  private contractCache: Record<string, CachedContract> = {};

  constructor(
    @InjectRepository(CommunityRoom)
    private readonly communityRoomRepository: Repository<CommunityRoom>,
    private readonly aeSdkService: AeSdkService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Resolve management → read state → map → diff → upsert → emit. Single source
   * of truth used by the plugin and the backfill. Returns whether it emitted.
   */
  async readAndUpsertRoomState(token: Token): Promise<RoomStateUpsertResult> {
    if (!token?.sale_address) {
      throw new Error('readAndUpsertRoomState: token.sale_address is required');
    }

    const existing = await this.communityRoomRepository.findOne({
      where: { sale_address: token.sale_address },
    });

    // A community we have ALREADY flagged deleted is terminal (relay 9008
    // recreate is impossible — task 10). If management is still gone we no-op.
    const alreadyDeletedCommunity =
      !!existing?.is_community && !!existing.deleted;

    let managementAddress: Encoded.ContractAddress | undefined;
    try {
      managementAddress = await this.resolveManagement(token.sale_address);
    } catch (error: any) {
      // A revert here typically means the community/DAO is gone. If we already
      // tracked it as a live community, mark it deleted; if already deleted,
      // no-op; otherwise treat as not-a-community and fall through to defaults.
      this.logger.warn(
        `get_community_management reverted for ${token.sale_address}: ${error?.message ?? error}`,
      );
      if (alreadyDeletedCommunity) {
        return this.terminalNoop(token, existing as CommunityRoom);
      }
      if (existing?.is_community) {
        return this.markDeleted(token, existing);
      }
      managementAddress = undefined;
    }

    // Not a community ([TG] token) — apply defaults. But if we *previously* knew
    // it as a community, this is a deletion (DAO removed), not a downgrade.
    if (!managementAddress) {
      if (alreadyDeletedCommunity) {
        return this.terminalNoop(token, existing as CommunityRoom);
      }
      if (existing?.is_community) {
        return this.markDeleted(token, existing);
      }
      return this.applyDefaults(token, existing);
    }

    let state: CommunityManagementState;
    try {
      state = await this.readManagementState(managementAddress);
    } catch (error: any) {
      // get_state reverted: the community/DAO is gone.
      this.logger.warn(
        `CommunityManagement.get_state reverted for ${managementAddress} (${token.sale_address}): ${error?.message ?? error}`,
      );
      if (alreadyDeletedCommunity) {
        return this.terminalNoop(token, existing as CommunityRoom);
      }
      if (existing?.is_community) {
        return this.markDeleted(token, existing);
      }
      throw error;
    }

    return this.persistCommunityState(token, state, existing);
  }

  /**
   * Upsert a non-community `[TG]` token's room with public defaults (D8). Still
   * emits `tgr.community.upserted` on first insert / any change.
   */
  async applyDefaults(
    token: Token,
    existing?: CommunityRoom | null,
  ): Promise<RoomStateUpsertResult> {
    const prior =
      existing ??
      (await this.communityRoomRepository.findOne({
        where: { sale_address: token.sale_address },
      }));

    const ownerAddress = token.owner_address ?? token.creator_address ?? '';
    const desired: Partial<CommunityRoom> = {
      sale_address: token.sale_address,
      token_address: token.address,
      symbol: token.symbol,
      owner_address: ownerAddress,
      is_private: false,
      min_token_threshold: new BigNumber(0),
      moderators: [],
      muted: [],
      is_community: false,
      deleted: false,
    };

    return this.writeAndMaybeEmit(token, desired, prior);
  }

  /**
   * Map an on-chain community `get_state()` record → `community_room` and persist.
   */
  private async persistCommunityState(
    token: Token,
    state: CommunityManagementState,
    existing: CommunityRoom | null,
  ): Promise<RoomStateUpsertResult> {
    const moderators = this.toStringArray(state.moderator_accounts);
    const muted = this.toStringArray(state.muted_user_ids);
    const threshold = new BigNumber(String(state.minimum_token_threshold));

    const desired: Partial<CommunityRoom> = {
      sale_address: token.sale_address,
      token_address: token.address,
      symbol: token.symbol,
      owner_address: state.owner,
      is_private: !!state.is_private,
      min_token_threshold: threshold,
      moderators,
      muted,
      is_community: true,
      deleted: false,
    };

    return this.writeAndMaybeEmit(token, desired, existing);
  }

  /**
   * Mark an existing community room as `deleted` (DAO/community removed). The row
   * is RETAINED (relay 9008 recreate is terminal — task 10 owns the publish).
   */
  private async markDeleted(
    token: Token,
    existing: CommunityRoom,
  ): Promise<RoomStateUpsertResult> {
    const desired: Partial<CommunityRoom> = {
      ...existing,
      deleted: true,
    };
    return this.writeAndMaybeEmit(token, desired, existing);
  }

  /**
   * Terminal state: an already-deleted community whose management is still gone.
   * Nothing to write, nothing to emit (deletion is terminal — task 10).
   */
  private terminalNoop(
    token: Token,
    existing: CommunityRoom,
  ): RoomStateUpsertResult {
    return {
      saleAddress: token.sale_address,
      emitted: false,
      isCommunity: existing.is_community,
      deleted: true,
    };
  }

  /**
   * Diff `desired` vs `existing`, upsert on PK `sale_address`, and emit
   * `tgr.community.upserted` only when something changed.
   */
  private async writeAndMaybeEmit(
    token: Token,
    desired: Partial<CommunityRoom>,
    existing: CommunityRoom | null,
  ): Promise<RoomStateUpsertResult> {
    const isNew = !existing;
    const changed = this.diff(existing, desired);
    const somethingChanged =
      isNew ||
      changed.moderators !== undefined ||
      changed.muted !== undefined ||
      changed.threshold === true ||
      changed.owner === true ||
      changed.is_private === true ||
      (existing?.is_community ?? false) !== (desired.is_community ?? false) ||
      (existing?.deleted ?? false) !== (desired.deleted ?? false);

    const now = new Date();
    const row: Partial<CommunityRoom> = {
      ...desired,
      state_synced_at: now,
    };

    // `created_height` is set on first insert and NEVER overwritten.
    if (isNew) {
      row.created_height = token.last_sync_block_height ?? null;
    } else {
      delete row.created_height;
    }

    await this.communityRoomRepository.upsert(row as CommunityRoom, {
      conflictPaths: ['sale_address'],
    });

    if (somethingChanged) {
      this.emitUpserted(desired, changed);
    }

    return {
      saleAddress: token.sale_address,
      emitted: somethingChanged,
      isCommunity: !!desired.is_community,
      deleted: !!desired.deleted,
    };
  }

  private emitUpserted(
    desired: Partial<CommunityRoom>,
    changed: TgrCommunityUpsertedDetail['changed'],
  ): void {
    const payload: TgrCommunityUpsertedDetail = {
      saleAddress: desired.sale_address as string,
      is_community: !!desired.is_community,
      is_private: !!desired.is_private,
      min_token_threshold: (
        desired.min_token_threshold ?? new BigNumber(0)
      ).toFixed(),
      owner_address: desired.owner_address ?? '',
      moderators: desired.moderators ?? [],
      muted: desired.muted ?? [],
      deleted: !!desired.deleted,
      changed,
    };
    this.eventEmitter.emit(TGR_COMMUNITY_UPSERTED, payload);
  }

  /**
   * Compute the change-set between the stored row and the desired state. Only
   * populated keys signal a change; `moderators`/`muted` carry added/removed.
   */
  private diff(
    existing: CommunityRoom | null,
    desired: Partial<CommunityRoom>,
  ): TgrCommunityUpsertedDetail['changed'] {
    if (!existing) {
      // New row: report the full sets as "added" so downstream (10) can publish.
      const moderators = desired.moderators ?? [];
      const muted = desired.muted ?? [];
      const changed: TgrCommunityUpsertedDetail['changed'] = {};
      if (moderators.length > 0) {
        changed.moderators = { added: [...moderators], removed: [] };
      }
      if (muted.length > 0) {
        changed.muted = { added: [...muted], removed: [] };
      }
      changed.threshold = true;
      changed.owner = true;
      changed.is_private = true;
      return changed;
    }

    const changed: TgrCommunityUpsertedDetail['changed'] = {};

    const modDiff = this.setDiff(
      existing.moderators ?? [],
      desired.moderators ?? [],
    );
    if (modDiff.added.length > 0 || modDiff.removed.length > 0) {
      changed.moderators = modDiff;
    }

    const mutedDiff = this.setDiff(existing.muted ?? [], desired.muted ?? []);
    if (mutedDiff.added.length > 0 || mutedDiff.removed.length > 0) {
      changed.muted = mutedDiff;
    }

    const existingThreshold = existing.min_token_threshold ?? new BigNumber(0);
    const desiredThreshold = desired.min_token_threshold ?? new BigNumber(0);
    if (!existingThreshold.isEqualTo(desiredThreshold)) {
      changed.threshold = true;
    }

    if ((existing.owner_address ?? '') !== (desired.owner_address ?? '')) {
      changed.owner = true;
    }

    if ((existing.is_private ?? false) !== (desired.is_private ?? false)) {
      changed.is_private = true;
    }

    return changed;
  }

  /** Set difference of two string lists (order-independent). */
  private setDiff(before: string[], after: string[]): SetDiff {
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const added = after.filter((x) => !beforeSet.has(x));
    const removed = before.filter((x) => !afterSet.has(x));
    return { added, removed };
  }

  /** Normalize a Sophia `Set.set` (JS `Set`) or array into a string[]. */
  private toStringArray(value: Set<string> | string[] | undefined): string[] {
    if (!value) {
      return [];
    }
    return Array.from(value).map((v) => String(v));
  }

  /**
   * Public resolver used by the plugin's allowlist refresh: returns the
   * `CommunityManagement` address for a sale, or `undefined` for `None`.
   */
  async resolveManagementAddress(
    saleAddress: string,
  ): Promise<string | undefined> {
    return this.resolveManagement(saleAddress);
  }

  /**
   * Resolve a token sale's `CommunityManagement` address via the cheap per-key
   * `get_community_management(sale)` entrypoint. Returns `undefined` for `None`
   * (the token is not a gated community — a `[TG]` token).
   */
  private async resolveManagement(
    saleAddress: string,
  ): Promise<Encoded.ContractAddress | undefined> {
    const factory = await this.getContract(
      BCL_CONTRACT.contractAddress,
      CommunityFactoryACI,
    );
    const { decodedResult } =
      await factory.get_community_management(saleAddress);
    if (!decodedResult) {
      return undefined;
    }
    return decodedResult as Encoded.ContractAddress;
  }

  /** Read `CommunityManagement.get_state()` via the cached per-address contract. */
  private async readManagementState(
    managementAddress: Encoded.ContractAddress,
  ): Promise<CommunityManagementState> {
    const management = await this.getContract(
      managementAddress,
      CommunityManagementACI,
    );
    const { decodedResult } = await management.get_state();
    return decodedResult as CommunityManagementState;
  }

  /**
   * Cached contract initializer (mirrors `BasePluginSyncService.getContract`):
   * one instance per address, LRU-evicted at `MAX_CACHED_CONTRACTS`. The
   * management ACI is shared across all rooms, so the cache key is the address.
   */
  private async getContract(
    contractAddress: string,
    aci: any,
  ): Promise<ContractInstance> {
    const cached = this.contractCache[contractAddress];
    if (cached) {
      cached.lastUsedAt = Date.now();
      return cached.instance;
    }
    const contract = await Contract.initialize({
      ...this.aeSdkService.sdk.getContext(),
      aci,
      address: contractAddress as Encoded.ContractAddress,
    });
    this.contractCache[contractAddress] = {
      instance: contract,
      lastUsedAt: Date.now(),
    };
    this.evictStalestContract();
    return contract;
  }

  private evictStalestContract(): void {
    const keys = Object.keys(this.contractCache);
    if (keys.length <= RoomStateService.MAX_CACHED_CONTRACTS) {
      return;
    }
    let oldestKey = keys[0];
    let oldestTime = this.contractCache[oldestKey]?.lastUsedAt ?? 0;
    for (const key of keys) {
      const t = this.contractCache[key]?.lastUsedAt ?? 0;
      if (t < oldestTime) {
        oldestTime = t;
        oldestKey = key;
      }
    }
    delete this.contractCache[oldestKey];
  }

  /** Test/introspection helper. */
  getCacheSize(): number {
    return Object.keys(this.contractCache).length;
  }
}

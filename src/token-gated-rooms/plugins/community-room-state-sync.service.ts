import { Injectable, Logger } from '@nestjs/common';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { BasePluginSyncService } from '@/plugins/base-plugin-sync.service';
import { SyncDirection } from '@/plugins/plugin.interface';
import CommunityManagementACI from '@/plugins/bcl/contract/aci/CommunityManagement.aci.json';

/**
 * Sync-service seam for the community-room-state plugin.
 *
 * The plugin's reactive work is driven by `LIVE_TX_EVENT` (see the plugin), not
 * the indexer `processBatch` pipeline, so `processTransaction` is intentionally a
 * no-op here and the plugin's `filters()` are empty. This class exists only to
 * satisfy `BasePlugin`'s abstract `getSyncService()` and to reuse the cached,
 * SDK-backed `getContract` helper for decoding `CommunityManagement` event logs.
 */
@Injectable()
export class CommunityRoomStateSyncService extends BasePluginSyncService {
  protected readonly logger = new Logger(CommunityRoomStateSyncService.name);

  constructor(aeSdkService: AeSdkService) {
    super(aeSdkService);
  }

  // Reactive upserts happen in the plugin's LIVE_TX_EVENT handler; nothing to do
  // in the batch pipeline (filters() is empty so this is never reached anyway).
  async processTransaction(
    _tx: Tx,
    _syncDirection: SyncDirection,
  ): Promise<void> {
    void _tx;
    void _syncDirection;
  }

  /**
   * Decode the event names emitted by a `CommunityManagement` contract call from
   * `tx.raw.log`. Returns the decoded event `name`s (e.g. `MuteUserId`,
   * `AddModerator`); unknown events are omitted. Tolerant of decode failures —
   * returns `[]` so the caller can decide based on the allowlist alone.
   */
  async decodeManagementEventNames(
    contractAddress: string,
    logs: any,
  ): Promise<string[]> {
    if (!Array.isArray(logs) || logs.length === 0) {
      return [];
    }
    try {
      const contract = await this.getContract(
        contractAddress as any,
        CommunityManagementACI,
      );
      const decoded = contract.$decodeEvents(logs, { omitUnknown: true });
      return (decoded || [])
        .map((e: any) => e?.name)
        .filter((n: any): n is string => typeof n === 'string');
    } catch (error: any) {
      this.logger.debug(
        `Failed to decode management events for ${contractAddress}: ${error?.message ?? error}`,
      );
      return [];
    }
  }
}

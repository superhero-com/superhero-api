import { Controller, Get, Param, Post, Query, DefaultValuePipe, ParseIntPipe } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { SyncState } from './entities/sync-state.entity';
import { PluginSyncState } from './entities/plugin-sync-state.entity';
import { PluginRegistryService } from './services/plugin-registry.service';
import { IndexerService } from './services/indexer.service';
import { LiveIndexerService } from './services/live-indexer.service';
import { BlockValidationService } from './services/block-validation.service';
import { Tx } from './entities/tx.entity';
import { KeyBlock } from './entities/key-block.entity';

@Controller('mdw')
export class MdwController {
  constructor(
    @InjectRepository(SyncState)
    private syncStateRepository: Repository<SyncState>,
    @InjectRepository(PluginSyncState)
    private pluginSyncStateRepository: Repository<PluginSyncState>,

    @InjectRepository(Tx)
    private mdwTxRepository: Repository<Tx>,
    @InjectRepository(KeyBlock)
    private keyBlockRepository: Repository<KeyBlock>,
    private dataSource: DataSource,
    private pluginRegistry: PluginRegistryService,
    private indexerService: IndexerService,
    private liveIndexerService: LiveIndexerService,
    private blockValidationService: BlockValidationService,
  ) {}

  @Get('health')
  async getHealth() {
    const hasIndexerHeadColumn = await this.hasSyncStateColumn('indexer_head_height');
    const syncStateQb = this.syncStateRepository
      .createQueryBuilder('sync_state')
      .where('sync_state.id = :id', { id: 'global' });
    if (hasIndexerHeadColumn) {
      syncStateQb.addSelect('sync_state.indexer_head_height');
    }
    const syncState = await syncStateQb.getOne();

    const pluginStates = await this.pluginSyncStateRepository.find();
    const totalTxs = await this.mdwTxRepository.count();

    if (!syncState) {
      return {
        status: 'critical',
        totalTxs,
        error: 'Sync state not found',
        plugins: pluginStates.map((state) => ({
          name: state.plugin_name,
          lastSyncedHeight: state.last_synced_height,
          backwardSyncedHeight: state.backward_synced_height,
          liveSyncedHeight: state.live_synced_height,
          startFromHeight: state.start_from_height,
        })),
        registeredPlugins: this.pluginRegistry.getPlugins().map((p) => p.name),
      };
    }

    const tipHeight = syncState.tip_height || 0;
    const backwardSyncedHeight = syncState.backward_synced_height ?? tipHeight;
    const liveSyncedHeight = syncState.live_synced_height ?? 0;
    const targetBackwardHeight = 0; // Backward sync target is always 0

    // Forward catch-up metrics (missing blocks while server was down)
    const localDbTipHeight = await this.getLocalTipHeight();
    // indexer_head_height is select:false and may not exist in older schemas.
    const indexerHeadHeight =
      typeof (syncState as any).indexer_head_height === 'number'
        ? (syncState as any).indexer_head_height
        : 0;
    const forwardCatchupRemaining = Math.max(0, tipHeight - indexerHeadHeight);
    const forwardCatchupProgress =
      tipHeight > 0
        ? Math.max(0, Math.min(100, (indexerHeadHeight / tipHeight) * 100))
        : 0;
    const forwardCatchupStatus =
      forwardCatchupRemaining === 0
        ? 'complete'
        : this.indexerService.getIsRunning()
          ? 'running'
          : 'stopped';

    // Calculate backward sync metrics
    const backwardSyncRemaining = Math.max(0, backwardSyncedHeight - targetBackwardHeight);
    const backwardSyncComplete = backwardSyncedHeight <= targetBackwardHeight;
    const backwardSyncProgress =
      tipHeight > 0
        ? Math.max(0, Math.min(100, ((tipHeight - backwardSyncedHeight) / tipHeight) * 100))
        : 0;
    const backwardSyncStatus = backwardSyncComplete
      ? 'complete'
      : this.indexerService.getIsRunning()
        ? 'running'
        : 'stopped';

    // Calculate live sync metrics
    // Note: live_synced_height can advance via websocket live indexing and/or forward catch-up on restart.
    const liveSyncLag = Math.max(0, tipHeight - liveSyncedHeight);
    const liveSyncProgress =
      tipHeight > 0 ? Math.max(0, Math.min(100, (liveSyncedHeight / tipHeight) * 100)) : 0;
    const liveSyncGapFromBackward = liveSyncedHeight - backwardSyncedHeight;
    const liveSyncStatus = this.liveIndexerService.getIsActive() ? 'active' : 'inactive';

    // Calculate validation metrics
    const isValidating = this.blockValidationService.getIsValidating();
    const validationStatus = isValidating ? 'validating' : 'idle';

    // Calculate comparison metrics
    const syncGap = liveSyncedHeight - backwardSyncedHeight;

    // Determine overall health status
    let overallStatus: 'healthy' | 'warning' | 'critical' = 'healthy';
    if (backwardSyncComplete && liveSyncLag > 100) {
      overallStatus = 'warning'; // Live sync lagging significantly
    } else if (liveSyncLag > 1000 || (!backwardSyncComplete && backwardSyncRemaining > 10000)) {
      overallStatus = 'warning';
    } else if (
      liveSyncLag > 5000 ||
      (!backwardSyncComplete && backwardSyncRemaining > 50000) ||
      !this.liveIndexerService.getIsActive()
    ) {
      overallStatus = 'critical';
    }

    return {
      status: overallStatus,
      totalTxs,
      forwardCatchup: {
        status: forwardCatchupStatus,
        // Only indexer_head_height is considered "final" for catch-up decisions.
        indexerHeadHeight,
        localDbTipHeight,
        remoteTipHeight: tipHeight,
        remainingBlocks: forwardCatchupRemaining,
        progressPercent: Number(forwardCatchupProgress.toFixed(2)),
      },
      backwardSync: {
        status: backwardSyncStatus,
        syncedHeight: backwardSyncedHeight,
        tipHeight: tipHeight,
        remainingBlocks: backwardSyncRemaining,
        progressPercent: Number(backwardSyncProgress.toFixed(2)),
        mode: syncState.is_bulk_mode ? 'bulk' : 'normal',
        isRunning: this.indexerService.getIsRunning(),
      },
      liveSync: {
        status: liveSyncStatus,
        syncedHeight: liveSyncedHeight,
        tipHeight: tipHeight,
        lag: liveSyncLag,
        progressPercent: Number(liveSyncProgress.toFixed(2)),
        gapFromBackwardSync: liveSyncGapFromBackward,
        isActive: this.liveIndexerService.getIsActive(),
      },
      validation: {
        status: validationStatus,
        isValidating: isValidating,
        lastValidationTime: syncState.updated_at || null,
      },
      comparison: {
        syncGap: syncGap,
        backwardSyncProgress: Number(backwardSyncProgress.toFixed(2)),
        liveSyncProgress: Number(liveSyncProgress.toFixed(2)),
      },
      plugins: pluginStates.map((state) => ({
        name: state.plugin_name,
        lastSyncedHeight: state.last_synced_height,
        backwardSyncedHeight: state.backward_synced_height,
        liveSyncedHeight: state.live_synced_height,
        startFromHeight: state.start_from_height,
      })),
      registeredPlugins: this.pluginRegistry.getPlugins().map((p) => p.name),
    };
  }

  private async getLocalTipHeight(): Promise<number> {
    const raw = await this.keyBlockRepository
      .createQueryBuilder('kb')
      .select('MAX(kb.height)', 'max')
      .getRawOne<{ max: string | number | null }>();

    const max = raw?.max;
    const n = typeof max === 'number' ? max : max ? parseInt(max, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  }

  private async hasSyncStateColumn(columnName: string): Promise<boolean> {
    const rows = await this.dataSource.query(
      `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'sync_state'
        AND column_name = $1
      LIMIT 1
      `,
      [columnName],
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  /**
   * Manually trigger plugin updateTransactions() (logs/data decoding + processing) for a single plugin.
   * Useful for debugging and backfilling after plugin version bumps.
   *
   * Example: POST /api/mdw/plugins/bcl-affiliation/update?batchSize=200
   */
  @Get('plugins/:name/update')
  async updatePlugin(
    @Param('name') name: string,
    @Query('batchSize', new DefaultValuePipe(100), ParseIntPipe) batchSize: number,
  ) {
    const plugin = this.pluginRegistry.getPluginByName(name);
    if (!plugin) {
      return { ok: false, error: `Plugin not found: ${name}` };
    }

    // Fire and await so caller can see success/failure in response.
    await plugin.updateTransactions(batchSize);
    return { ok: true, plugin: name, batchSize };
  }
}

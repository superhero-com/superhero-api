import { Controller, Get } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SyncState } from './entities/sync-state.entity';
import { PluginSyncState } from './entities/plugin-sync-state.entity';
import { PluginRegistryService } from './services/plugin-registry.service';
import { Tx } from './entities/tx.entity';

@Controller('mdw')
export class MdwController {
  constructor(
    @InjectRepository(SyncState)
    private syncStateRepository: Repository<SyncState>,
    @InjectRepository(PluginSyncState)
    private pluginSyncStateRepository: Repository<PluginSyncState>,

    @InjectRepository(Tx)
    private mdwTxRepository: Repository<Tx>,
    private pluginRegistry: PluginRegistryService,
  ) {}

  @Get('health')
  async getHealth() {
    const syncState = await this.syncStateRepository.findOne({
      where: { id: 'global' },
    });

    const pluginStates = await this.pluginSyncStateRepository.find();

    const totalTxs = await this.mdwTxRepository.count();
    return {
      status: 'healthy',
      totalTxs,
      syncState: syncState
        ? {
            lastSyncedHeight: syncState.last_synced_height,
            tipHeight: syncState.tip_height,
            lag: syncState.tip_height - syncState.last_synced_height,
            backwardSyncedHeight: syncState.backward_synced_height,
            liveSyncedHeight: syncState.live_synced_height,
            backwardSyncRemaining: syncState.backward_synced_height
              ? syncState.backward_synced_height
              : null,
            liveSyncLag: syncState.live_synced_height
              ? syncState.tip_height - syncState.live_synced_height
              : null,
          }
        : null,
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
}

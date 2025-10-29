import { Controller, Get } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MdwSyncState } from './entities/mdw-sync-state.entity';
import { MdwPluginSyncState } from './entities/mdw-plugin-sync-state.entity';
import { PluginRegistryService } from './services/plugin-registry.service';

@Controller('mdw')
export class MdwController {
  constructor(
    @InjectRepository(MdwSyncState)
    private syncStateRepository: Repository<MdwSyncState>,
    @InjectRepository(MdwPluginSyncState)
    private pluginSyncStateRepository: Repository<MdwPluginSyncState>,
    private pluginRegistry: PluginRegistryService,
  ) {}

  @Get('health')
  async getHealth() {
    const syncState = await this.syncStateRepository.findOne({
      where: { id: 'global' },
    });

    const pluginStates = await this.pluginSyncStateRepository.find();

    return {
      status: 'healthy',
      syncState: syncState
        ? {
            lastSyncedHeight: syncState.last_synced_height,
            tipHeight: syncState.tip_height,
            lag: syncState.tip_height - syncState.last_synced_height,
          }
        : null,
      plugins: pluginStates.map((state) => ({
        name: state.plugin_name,
        lastSyncedHeight: state.last_synced_height,
        startFromHeight: state.start_from_height,
        isActive: state.is_active,
      })),
      registeredPlugins: this.pluginRegistry.getPlugins().map((p) => p.name),
    };
  }
}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tx } from '../../entities/tx.entity';
import { PluginSyncState } from '../../entities/plugin-sync-state.entity';
import { BclPlugin } from './bcl.plugin';
import { BclPluginSyncService } from './bcl-plugin-sync.service';
@Module({
  imports: [TypeOrmModule.forFeature([Tx, PluginSyncState])],
  providers: [BclPluginSyncService, BclPlugin],
  exports: [BclPlugin],
})
export class BclPluginModule {}


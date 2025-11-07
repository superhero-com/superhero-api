import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tx } from '../../entities/tx.entity';
import { PluginSyncState } from '../../entities/plugin-sync-state.entity';
import { SocialPlugin } from './social.plugin';
import { SocialPluginSyncService } from './social-plugin-sync.service';
@Module({
  imports: [TypeOrmModule.forFeature([Tx, PluginSyncState])],
  providers: [SocialPluginSyncService, SocialPlugin],
  exports: [SocialPlugin],
})
export class SocialPluginModule {}


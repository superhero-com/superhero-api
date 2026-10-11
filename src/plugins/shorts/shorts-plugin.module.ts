import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AeModule } from '@/ae/ae.module';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { ShortsIndexModule } from '@/shorts/shorts-index.module';
import { SHORTS_PLUGIN } from '@/shorts/shorts-index.service';
import { ShortsPlugin } from './shorts.plugin';
import { ShortsPluginSyncService } from './shorts-plugin-sync.service';
import { ShortsBackfillService } from './shorts-backfill.service';

@Module({
  imports: [
    ConfigModule,
    AeModule,
    ShortsIndexModule,
    TypeOrmModule.forFeature([Tx, PluginSyncState]),
  ],
  providers: [
    ShortsPlugin,
    ShortsPluginSyncService,
    ShortsBackfillService,
    { provide: SHORTS_PLUGIN, useExisting: ShortsPlugin },
  ],
  exports: [SHORTS_PLUGIN],
})
export class ShortsPluginModule {}

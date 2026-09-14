import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AeModule } from '@/ae/ae.module';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import mdwConfig from '@/mdw-sync/config/mdw.config';
import { SocialGraphEdge } from './entities/social-graph-edge.entity';
import { SocialGraphCount } from './entities/social-graph-count.entity';
import { SocialGraphBackfillState } from './entities/social-graph-backfill-state.entity';
import { SocialGraphPlugin } from './social-graph.plugin';
import { SocialGraphPluginSyncService } from './social-graph-plugin-sync.service';
import { SocialGraphBackfillService } from './services/social-graph-backfill.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Tx,
      PluginSyncState,
      SocialGraphEdge,
      SocialGraphCount,
      SocialGraphBackfillState,
    ]),
    // SocialGraphBackfillService injects ConfigService to read
    // `mdw.middlewareUrl` — the same source the indexer uses. forFeature both
    // provides ConfigService here and loads that namespace.
    ConfigModule.forFeature(mdwConfig),
    AeModule,
  ],
  providers: [
    SocialGraphPluginSyncService,
    SocialGraphPlugin,
    SocialGraphBackfillService,
  ],
  exports: [SocialGraphPlugin],
})
export class SocialGraphPluginModule {}

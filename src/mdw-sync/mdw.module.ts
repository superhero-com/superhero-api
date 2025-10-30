import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { Tx } from './entities/tx.entity';
import { KeyBlock } from './entities/key-block.entity';
import { SyncState } from './entities/sync-state.entity';
import { PluginSyncState } from './entities/plugin-sync-state.entity';
import { PluginRegistryService } from './services/plugin-registry.service';
import { IndexerService } from './services/indexer.service';
import { ReorgService } from './services/reorg.service';
import { MdwController } from './mdw.controller';
import mdwConfig from './config/mdw.config';
import { MDW_PLUGIN } from './plugins/plugin.tokens';
import { DexPluginModule } from '@/plugins/dex/dex-plugin.module';
import { SocialPluginModule } from '@/plugins/social/social-plugin.module';
import { TippingPluginModule } from '@/plugins/tipping/tipping-plugin.module';
import { DexPlugin } from '@/plugins/dex/dex.plugin';
import { SocialPlugin } from '@/plugins/social/social.plugin';
import { TippingPlugin } from '@/plugins/tipping/tipping.plugin';

@Module({
  imports: [
    ConfigModule.forFeature(mdwConfig),
    TypeOrmModule.forFeature([Tx, KeyBlock, SyncState, PluginSyncState]),
    // Import plugin modules so their providers are visible in this context
    DexPluginModule,
    SocialPluginModule,
    TippingPluginModule,
  ],
  controllers: [MdwController],
  providers: [
    PluginRegistryService,
    IndexerService,
    ReorgService,
    // Aggregate all plugin classes into a single MDW_PLUGIN token (array)
    {
      provide: MDW_PLUGIN,
      useFactory: (
        dex: DexPlugin,
        social: SocialPlugin,
        tipping: TippingPlugin,
      ) => [dex, social, tipping],
      inject: [DexPlugin, SocialPlugin, TippingPlugin],
    },
  ],
  exports: [IndexerService, ReorgService, PluginRegistryService],
})
export class MdwModule {}

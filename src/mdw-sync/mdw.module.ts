import { DexPluginModule } from '@/plugins/dex/dex-plugin.module';
import { DexPlugin } from '@/plugins/dex/dex.plugin';
import { SocialPluginModule } from '@/plugins/social/social-plugin.module';
import { SocialPlugin } from '@/plugins/social/social.plugin';
import { TippingPluginModule } from '@/plugins/tipping/tipping-plugin.module';
import { TippingPlugin } from '@/plugins/tipping/tipping.plugin';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TypeOrmModule } from '@nestjs/typeorm';
import mdwConfig from './config/mdw.config';
import { KeyBlock } from './entities/key-block.entity';
import { PluginSyncState } from './entities/plugin-sync-state.entity';
import { SyncState } from './entities/sync-state.entity';
import { Tx } from './entities/tx.entity';
import { MdwController } from './mdw.controller';
import { MDW_PLUGIN } from './plugins/plugin.tokens';
import { IndexerService } from './services/indexer.service';
import { PluginRegistryService } from './services/plugin-registry.service';
import { ReorgService } from './services/reorg.service';
import { TxSubscriber } from './subscribers/tx.subscriber';

@Module({
  imports: [
    ConfigModule.forFeature(mdwConfig),
    EventEmitterModule.forRoot(),
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
    // Subscribers
    TxSubscriber,
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

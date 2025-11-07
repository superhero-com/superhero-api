import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TypeOrmModule } from '@nestjs/typeorm';
import mdwConfig from './config/mdw.config';
import { KeyBlock } from './entities/key-block.entity';
import { MicroBlock } from './entities/micro-block.entity';
import { PluginSyncState } from './entities/plugin-sync-state.entity';
import { SyncState } from './entities/sync-state.entity';
import { Tx } from './entities/tx.entity';
import { MdwController } from './mdw.controller';
import { KeyBlocksController } from './controllers/key-blocks.controller';
import { MicroBlocksController } from './controllers/micro-blocks.controller';
import { TxsController } from './controllers/txs.controller';
import { PluginSyncStateController } from './controllers/plugin-sync-state.controller';
import { SyncStateController } from './controllers/sync-state.controller';
import { IndexerService } from './services/indexer.service';
import { PluginRegistryService } from './services/plugin-registry.service';
import { ReorgService } from './services/reorg.service';
import { TxSubscriber } from './subscribers/tx.subscriber';
import { MDW_PLUGIN } from './plugins/plugin.tokens';

@Module({
  imports: [
    ConfigModule.forFeature(mdwConfig),
    EventEmitterModule.forRoot(),
    TypeOrmModule.forFeature([
      Tx,
      KeyBlock,
      MicroBlock,
      SyncState,
      PluginSyncState,
    ]),
    // TODO: Import plugin modules so their providers are visible in this context
    // DexPluginModule,
    // SocialPluginModule,
    // TippingPluginModule,
  ],
  controllers: [
    MdwController,
    KeyBlocksController,
    MicroBlocksController,
    TxsController,
    PluginSyncStateController,
    SyncStateController,
  ],
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

      ) => [],
      inject: [],
    },
  ],
  exports: [IndexerService, ReorgService, PluginRegistryService],
})
export class MdwModule { }

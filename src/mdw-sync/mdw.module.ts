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
import { KeyBlocksResolver } from './resolvers/key-blocks.resolver';
import { MicroBlocksResolver } from './resolvers/micro-blocks.resolver';
import { TxsResolver } from './resolvers/txs.resolver';
import { IndexerService } from './services/indexer.service';
import { PluginRegistryService } from './services/plugin-registry.service';
import { ReorgService } from './services/reorg.service';
import { TxSubscriber } from './subscribers/tx.subscriber';
import { MDW_PLUGIN } from './plugins/plugin.tokens';
import { createEntityControllers, createEntityResolvers } from './factories/entity-factory';
import {
  ENTITY_CONFIGS,
  SYNC_STATE_CONFIG,
  PLUGIN_SYNC_STATE_CONFIG,
} from './config/entity-configs';

// Generate controllers for all entities
const generatedControllers = createEntityControllers(ENTITY_CONFIGS);

// Generate resolvers for simple entities (without custom ResolveFields)
const generatedResolvers = createEntityResolvers([
  SYNC_STATE_CONFIG,
  PLUGIN_SYNC_STATE_CONFIG,
]);

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
    ...generatedControllers,
  ],
  providers: [
    PluginRegistryService,
    IndexerService,
    ReorgService,
    // Subscribers
    TxSubscriber,
    // GraphQL Resolvers - use generated for simple entities, keep custom for complex ones
    ...generatedResolvers,
    // Keep existing resolvers for entities with custom ResolveFields
    KeyBlocksResolver,
    MicroBlocksResolver,
    TxsResolver,
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

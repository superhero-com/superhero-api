import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TypeOrmModule } from '@nestjs/typeorm';
import mdwConfig from './config/mdw.config';
import { KeyBlock } from './entities/key-block.entity';
import { MicroBlock } from './entities/micro-block.entity';
import { PluginSyncState } from './entities/plugin-sync-state.entity';
import { PluginFailedTransaction } from './entities/plugin-failed-transaction.entity';
import { SyncState } from './entities/sync-state.entity';
import { Tx } from './entities/tx.entity';
import { MdwController } from './mdw.controller';
import { IndexerService } from './services/indexer.service';
import { LiveIndexerService } from './services/live-indexer.service';
import { PluginRegistryService } from './services/plugin-registry.service';
import { PluginBatchProcessorService } from './services/plugin-batch-processor.service';
import { PluginFailedTransactionService } from './services/plugin-failed-transaction.service';
import { ReorgService } from './services/reorg.service';
import { MDW_PLUGIN } from '@/plugins/plugin.tokens';
import { BclPluginModule } from '@/plugins/bcl/bcl-plugin.module';
import { SocialPluginModule } from '@/plugins/social/social-plugin.module';
import { getPluginProvider } from '@/plugins';
import { createEntityControllers, createEntityResolvers } from '@/api-core/factories/entity-factory';
import { ENTITY_CONFIGS } from './config/entity-configs';

// Generate controllers for all entities
const generatedControllers = createEntityControllers(ENTITY_CONFIGS);

// Generate resolvers for all entities (now supports automatic relation resolution)
const generatedResolvers = createEntityResolvers(ENTITY_CONFIGS);

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
      PluginFailedTransaction,
    ]),
    // Import plugin modules
    BclPluginModule,
    SocialPluginModule,
  ],
  controllers: [
    MdwController,
    ...generatedControllers,
  ],
  providers: [
    PluginRegistryService,
    PluginBatchProcessorService,
    PluginFailedTransactionService,
    IndexerService,
    LiveIndexerService,
    ReorgService,
    // GraphQL Resolvers - all generated with automatic relation resolution
    ...generatedResolvers,
    // Aggregate all plugin classes into a single MDW_PLUGIN token (array)
    getPluginProvider(),
  ],
  exports: [
    IndexerService,
    LiveIndexerService,
    ReorgService,
    PluginRegistryService,
    PluginBatchProcessorService,
  ],
})
export class MdwModule { }

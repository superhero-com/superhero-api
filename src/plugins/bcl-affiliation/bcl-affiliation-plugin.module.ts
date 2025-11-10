import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { AeModule } from '@/ae/ae.module';
import { Invitation } from '@/affiliation/entities/invitation.entity';
import { BclAffiliationPlugin } from './bcl-affiliation.plugin';
import { BclAffiliationPluginSyncService } from './bcl-affiliation-plugin-sync.service';
import { BclAffiliationTransactionProcessorService } from './services/bcl-affiliation-transaction-processor.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Tx, PluginSyncState, Invitation]),
    AeModule,
  ],
  providers: [
    BclAffiliationTransactionProcessorService,
    BclAffiliationPluginSyncService,
    BclAffiliationPlugin,
  ],
  exports: [BclAffiliationPlugin],
})
export class BclAffiliationPluginModule {}


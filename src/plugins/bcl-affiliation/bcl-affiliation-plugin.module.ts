import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { AeModule } from '@/ae/ae.module';
import { Invitation } from '@/affiliation/entities/invitation.entity';
import { BclAffiliationPlugin } from './bcl-affiliation.plugin';
import { BclAffiliationPluginSyncService } from './bcl-affiliation-plugin-sync.service';
import { BclAffiliationTransactionProcessorService } from './services/bcl-affiliation-transaction-processor.service';
import { BclInvitationRedeemed } from './entities/bcl-invitation-redeemed.view';
import { BclInvitationRevoked } from './entities/bcl-invitation-revoked.view';
import { BclInvitationRegistered } from './entities/bcl-invitation-registered.view';
import { BclAffiliationInvitationsService } from './services/bcl-affiliation-invitations.service';
import { BclAffiliationInvitationsController } from './controllers/bcl-affiliation-invitations.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Tx,
      PluginSyncState,
      Invitation,
      BclInvitationRegistered,
      BclInvitationRedeemed,
      BclInvitationRevoked,
    ]),
    AeModule,
  ],
  providers: [
    BclAffiliationTransactionProcessorService,
    BclAffiliationInvitationsService,
    BclAffiliationPluginSyncService,
    BclAffiliationPlugin,
  ],
  controllers: [BclAffiliationInvitationsController],
  exports: [BclAffiliationPlugin],
})
export class BclAffiliationPluginModule {}


import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AeModule } from '@/ae/ae.module';
import { MDW_PLUGIN } from '@/mdw-sync/plugins/plugin.tokens';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { AffiliationPlugin } from './affiliation.plugin';
import { AffiliationTxListener } from './listeners/affiliation-tx.listener';
import { AffiliationSyncTransactionService } from './services/affiliation-sync-transaction.service';
import { Invitation } from './entities/invitation.entity';
import { AffiliationCode } from './entities/affiliation-code.entity';
import { Affiliation } from './entities/affiliation.entity';
import { AffiliationController } from './controllers/affiliation.controller';
import { InvitationsController } from './controllers/invitations.controller';
import { AffiliationService } from './services/affiliation.service';
import { InvitationService } from './services/invitation.service';
import { OauthService } from './services/oauth.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Tx,
      PluginSyncState,
      Invitation,
      AffiliationCode,
      Affiliation,
    ]),
    AeModule,
  ],
  controllers: [AffiliationController, InvitationsController],
  providers: [
    AffiliationPlugin,
    {
      provide: MDW_PLUGIN,
      useClass: AffiliationPlugin,
    },
    AffiliationTxListener,
    AffiliationSyncTransactionService,
    AffiliationService,
    InvitationService,
    OauthService,
  ],
  exports: [AffiliationPlugin, TypeOrmModule],
})
export class AffiliationPluginModule {}

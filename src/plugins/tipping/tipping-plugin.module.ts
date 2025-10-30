import { AccountModule } from '@/plugins/account/account.module';
import { Account } from '@/plugins/account/entities/account.entity';
import { AeModule } from '@/ae/ae.module';
import { MDW_PLUGIN } from '@/mdw-sync/plugins/plugin.tokens';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { Post } from '@/plugins/social/entities/post.entity';
import { Tip } from '@/plugins/tipping/entities/tip.entity';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SocialPluginModule } from '../social/social-plugin.module';
import { TipsController } from './controllers/tips.controller';
import { TippingPlugin } from './tipping.plugin';
import { TippingTxListener } from './listeners/tipping-tx.listener';
import { TippingSyncTransactionService } from './services/tipping-sync-transaction.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Tx, PluginSyncState, Tip, Post, Account]),
    AeModule,
    AccountModule,
    // If tipping needs anything else from social, keep the module imported as well
    SocialPluginModule,
  ],
  providers: [
    TippingPlugin,
    {
      provide: MDW_PLUGIN,
      useClass: TippingPlugin,
    },
    TippingTxListener,
    TippingSyncTransactionService,
  ],
  exports: [TippingPlugin],
  controllers: [TipsController],
})
export class TippingPluginModule {
  //
}

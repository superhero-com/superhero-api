import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { AeModule } from '@/ae/ae.module';
import { AccountModule } from '@/account/account.module';
import { Tip } from '@/tipping/entities/tip.entity';
import { Account } from '@/account/entities/account.entity';
import { Post } from '@/social/entities/post.entity';
import { SocialTippingPlugin } from './social-tipping.plugin';
import { SocialTippingPluginSyncService } from './social-tipping-plugin-sync.service';
import { SocialTippingTransactionProcessorService } from './services/social-tipping-transaction-processor.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Tx, PluginSyncState, Tip, Account, Post]),
    AeModule,
    AccountModule,
  ],
  providers: [
    SocialTippingTransactionProcessorService,
    SocialTippingPluginSyncService,
    SocialTippingPlugin,
  ],
  exports: [SocialTippingPlugin],
})
export class SocialTippingPluginModule {}


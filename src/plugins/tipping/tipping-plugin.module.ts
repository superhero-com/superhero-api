import { AccountModule } from '@/plugins/account/account.module';
import { Account } from '@/plugins/account/entities/account.entity';
import { AeModule } from '@/ae/ae.module';
import { MDW_PLUGIN } from '@/mdw-sync/plugins/plugin.tokens';
import { Post } from '@/plugins/social/entities/post.entity';
import { Tip } from '@/plugins/tipping/entities/tip.entity';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SocialPluginModule } from '../social/social-plugin.module';
import { TipsController } from './controllers/tips.controller';
import { TippingPlugin } from './tipping.plugin';

@Module({
  imports: [
    TypeOrmModule.forFeature([Tip, Post, Account]),
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
  ],
  exports: [TippingPlugin],
  controllers: [TipsController],
})
export class TippingPluginModule {
  //
}

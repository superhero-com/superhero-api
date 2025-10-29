import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TippingPlugin } from './tipping.plugin';
import { Tip } from '@/tipping/entities/tip.entity';
import { Post } from '@/social/entities/post.entity';
import { Account } from '@/account/entities/account.entity';
import { MDW_PLUGIN } from '@/mdw/plugins/plugin.tokens';

@Module({
  imports: [TypeOrmModule.forFeature([Tip, Post, Account])],
  providers: [
    TippingPlugin,
    {
      provide: MDW_PLUGIN,
      useClass: TippingPlugin,
    },
  ],
  exports: [TippingPlugin],
})
export class TippingPluginModule {}

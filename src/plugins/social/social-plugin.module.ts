import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SocialPlugin } from './social.plugin';
import { Post } from '@/social/entities/post.entity';
import { Topic } from '@/social/entities/topic.entity';
import { Account } from '@/account/entities/account.entity';
import { MDW_PLUGIN } from '@/mdw/plugins/plugin.tokens';

@Module({
  imports: [TypeOrmModule.forFeature([Post, Topic, Account])],
  providers: [
    SocialPlugin,
    {
      provide: MDW_PLUGIN,
      useClass: SocialPlugin,
    },
  ],
  exports: [SocialPlugin],
})
export class SocialPluginModule {}

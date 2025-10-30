import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SocialPlugin } from './social.plugin';
import { Post } from '@/plugins/social/entities/post.entity';
import { Topic } from '@/plugins/social/entities/topic.entity';
import { Account } from '@/plugins/account/entities/account.entity';
import { MDW_PLUGIN } from '@/mdw-sync/plugins/plugin.tokens';
import { AeModule } from '@/ae/ae.module';
import { AccountModule } from '@/plugins/account/account.module';
import { TopicsController } from './controllers/topics.controller';
import { PostsController } from './controllers/posts.controller';
@Module({
  imports: [TypeOrmModule.forFeature([Post, Topic, Account])],
  providers: [
    AeModule,
    AccountModule,
    SocialPlugin,
    {
      provide: MDW_PLUGIN,
      useClass: SocialPlugin,
    },
  ],
  exports: [SocialPlugin, TypeOrmModule],
  controllers: [PostsController, TopicsController],
})
export class SocialPluginModule {}

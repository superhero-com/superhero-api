import { AeModule } from '@/ae/ae.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Post } from './entities/post.entity';
import { Topic } from './entities/topic.entity';
import { PostService } from './services/post.service';
import { TransactionsModule } from '@/transactions/transactions.module';
import { PostsController } from './controllers/posts.controller';
import { TopicsController } from './controllers/topics.controller';
import { AccountModule } from '@/account/account.module';

@Module({
  imports: [
    AeModule,
    AccountModule,
    TransactionsModule,
    TypeOrmModule.forFeature([Post, Topic]),
  ],
  providers: [PostService],
  exports: [PostService, TypeOrmModule],
  controllers: [PostsController, TopicsController],
})
export class PostModule {
  //
}

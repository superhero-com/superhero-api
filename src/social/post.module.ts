import { AeModule } from '@/ae/ae.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Post } from './entities/post.entity';
import { PostService } from './services/post.service';
import { TransactionsModule } from '@/transactions/transactions.module';
import { PostsController } from './controllers/posts.controller';
import { AccountModule } from '@/account/account.module';

@Module({
  imports: [
    AeModule,
    AccountModule,
    TransactionsModule,
    TypeOrmModule.forFeature([Post]),
  ],
  providers: [PostService],
  exports: [PostService],
  controllers: [PostsController],
})
export class PostModule {
  //
}

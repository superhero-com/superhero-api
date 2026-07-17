import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Post } from '@/social/entities/post.entity';
import { Token } from '@/tokens/entities/token.entity';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { PostModule } from '@/social/post.module';
import { FeedController } from './feed.controller';

// Kept a leaf module: PostModule already imports TokensModule/TransactionsModule,
// so importing either of those back here would risk a circular module graph.
@Module({
  imports: [
    PostModule,
    TypeOrmModule.forFeature([Post, Token, Transaction]),
  ],
  controllers: [FeedController],
})
export class FeedModule {}

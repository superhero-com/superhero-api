import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Token } from '@/tokens/entities/token.entity';
import { Post } from '@/social/entities/post.entity';
import { AccountModule } from '@/account/account.module';
import { SearchController } from './search.controller';

@Module({
  imports: [AccountModule, TypeOrmModule.forFeature([Token, Post])],
  controllers: [SearchController],
})
export class SearchModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Post } from './entities/post.entity';
import { Topic } from './entities/topic.entity';
import { Tip } from '@/tipping/entities/tip.entity';
import { TrendingTag } from '@/trending-tags/entities/trending-tags.entity';
import { Token } from '@/tokens/entities/token.entity';
import { PostReadsDaily } from './entities/post-reads.entity';
import { ReadsService } from './services/reads.service';
import { PostService } from './services/post.service';
import { PopularRankingService } from './services/popular-ranking.service';
import { TransactionsModule } from '@/transactions/transactions.module';
import { PostsController } from './controllers/posts.controller';
import { TopicsController } from './controllers/topics.controller';
import { GiphyController } from './controllers/giphy.controller';
import { GovernancePluginModule } from '@/plugins/governance/governance-plugin.module';
import { getPopularRankingContributorProvider } from '@/plugins';
import { ProfileModule } from '@/profile/profile.module';
import { TokensModule } from '@/tokens/tokens.module';

@Module({
  imports: [
    ProfileModule,
    TokensModule,
    TransactionsModule,
    GovernancePluginModule, // Import to access GovernancePopularRankingService
    TypeOrmModule.forFeature([
      Post,
      Topic,
      Tip,
      TrendingTag,
      Token,
      PostReadsDaily,
    ]),
  ],
  providers: [
    PostService,
    PopularRankingService,
    ReadsService,
    getPopularRankingContributorProvider(),
  ],
  exports: [PostService, PopularRankingService, ReadsService, TypeOrmModule],
  controllers: [PostsController, TopicsController, GiphyController],
})
export class PostModule {
  //
}

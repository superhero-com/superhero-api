import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Post } from './entities/post.entity';
import { Topic } from './entities/topic.entity';
import { Tip } from '@/tipping/entities/tip.entity';
import { TrendingTag } from '@/trending-tags/entities/trending-tags.entity';
import { Token } from '@/tokens/entities/token.entity';
import { PostReadsDaily } from './entities/post-reads.entity';
import { PostAnalytic } from './entities/post-analytic.entity';
import { ReadsService } from './services/reads.service';
import { PostService } from './services/post.service';
import { PopularRankingService } from './services/popular-ranking.service';
import { CacheDailyPostAnalyticsService } from './services/cache-daily-post-analytics.service';
import { TransactionsModule } from '@/transactions/transactions.module';
import { PostsController } from './controllers/posts.controller';
import { TopicsController } from './controllers/topics.controller';
import { GiphyController } from './controllers/giphy.controller';
import { PostAnalyticsController } from './controllers/post-analytics.controller';
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
      PostAnalytic,
    ]),
  ],
  providers: [
    PostService,
    PopularRankingService,
    ReadsService,
    CacheDailyPostAnalyticsService,
    getPopularRankingContributorProvider(),
  ],
  exports: [PostService, PopularRankingService, ReadsService, TypeOrmModule],
  controllers: [
    // Register PostAnalyticsController BEFORE PostsController so that its
    // /posts/analytics/* routes are matched before PostsController's /posts/:id.
    PostAnalyticsController,
    PostsController,
    TopicsController,
    GiphyController,
  ],
})
export class PostModule {
  //
}

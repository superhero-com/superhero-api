import { AeModule } from '@/ae/ae.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Post } from './entities/post.entity';
import { Topic } from './entities/topic.entity';
import { Tip } from '@/tipping/entities/tip.entity';
import { TrendingTag } from '@/trending-tags/entities/trending-tags.entity';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import { Token } from '@/tokens/entities/token.entity';
import { Invitation } from '@/affiliation/entities/invitation.entity';
import { PostReadsDaily } from './entities/post-reads.entity';
import { ReadsService } from './services/reads.service';
import { PostService } from './services/post.service';
import { PopularRankingService } from './services/popular-ranking.service';
import { TransactionsModule } from '@/transactions/transactions.module';
import { PostsController } from './controllers/posts.controller';
import { TopicsController } from './controllers/topics.controller';
import { AccountModule } from '@/account/account.module';
import { GovernancePluginModule } from '@/plugins/governance/governance-plugin.module';
import { POPULAR_RANKING_CONTRIBUTOR } from '@/plugins/plugin.tokens';
import { getPopularRankingContributorProvider } from '@/plugins';
import { ProfileModule } from '@/profile/profile.module';

@Module({
  imports: [
    AeModule,
    AccountModule,
    ProfileModule,
    TransactionsModule,
    GovernancePluginModule, // Import to access GovernancePopularRankingService
    TypeOrmModule.forFeature([
      Post,
      Topic,
      Tip,
      TrendingTag,
      TokenHolder,
      Token,
      Invitation,
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
  controllers: [PostsController, TopicsController],
})
export class PostModule {
  //
}

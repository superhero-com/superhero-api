import { Module } from '@nestjs/common';
import { AeModule } from '@/ae/ae.module';
import { SocialGraphService } from './social-graph.service';
import { SocialGraphQueryService } from './social-graph-query.service';

@Module({
  imports: [AeModule],
  providers: [SocialGraphService, SocialGraphQueryService],
  exports: [SocialGraphService, SocialGraphQueryService],
})
export class SocialGraphReadModule {}

import { Module } from '@nestjs/common';
import { ProfileModule } from '@/profile/profile.module';
import { SocialGraphReadModule } from './social-graph-read.module';
import { SocialGraphPluginModule } from './social-graph-plugin.module';
import { SocialGraphController } from './social-graph.controller';

@Module({
  imports: [ProfileModule, SocialGraphReadModule, SocialGraphPluginModule],
  controllers: [SocialGraphController],
  exports: [SocialGraphReadModule],
})
export class SocialGraphModule {}

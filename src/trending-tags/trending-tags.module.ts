import { AeModule } from '@/ae/ae.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TrendingTag } from './entities/trending-tags.entity';
import { TrendingTagsService } from './services/trending-tags.service';
import { TrendingTagsController } from './controllers/trending-tags.controller';

@Module({
  imports: [AeModule, TypeOrmModule.forFeature([TrendingTag])],
  providers: [TrendingTagsService],
  exports: [],
  controllers: [TrendingTagsController],
})
export class TrendingTagsModule {
  //
}

import { PULL_TRENDING_TAGS_ENABLED } from '@/configs/constants';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TrendingTag } from '../entities/trending-tags.entity';

@Injectable()
export class TrendingTagsService {
  private readonly logger = new Logger(TrendingTagsService.name);

  constructor(
    @InjectRepository(TrendingTag)
    private readonly trendingTagRepository: Repository<TrendingTag>,
  ) {
    //
  }

  onModuleInit() {
    if (PULL_TRENDING_TAGS_ENABLED) {
      this.saveAllTrendingTags();
    }
  }

  isPullingTrendingTags = false;
  async saveAllTrendingTags() {
    if (this.isPullingTrendingTags) {
      return;
    }
    this.isPullingTrendingTags = true;
    try {
      // TODO
    } catch (error) {
      this.logger.error('Error pulling and saving trending tags', error);
    }
    this.isPullingTrendingTags = false;
  }
}

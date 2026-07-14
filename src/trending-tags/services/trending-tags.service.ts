import { PULL_TRENDING_TAGS_ENABLED } from '@/configs/constants';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateTrendingTagsDto } from '../dto/create-trending-tags.dto';
import { TrendingTag } from '../entities/trending-tags.entity';
import { normalizeTagName } from '../utils/tag-name.util';

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

  /**
   * Create trending tags from external provider data
   */
  async createTrendingTags(
    data: CreateTrendingTagsDto,
  ): Promise<{ created: number; updated: number; errors: string[] }> {
    const results = {
      created: 0,
      updated: 0,
      errors: [] as string[],
    };

    // if normalizedTags length, delete all trending tags
    if (data.items.length) {
      await this.trendingTagRepository.clear();
    }

    for (const item of data.items) {
      try {
        const normalizedTag = normalizeTagName(item.tag);

        // Skip if normalized tag is empty
        if (!normalizedTag) {
          results.errors.push(
            `Tag "${item.tag}" resulted in empty normalized tag`,
          );
          continue;
        }

        // Check if tag already exists
        const existingTag = await this.trendingTagRepository.findOne({
          where: { tag: normalizedTag },
        });

        if (existingTag) {
          // Update existing tag
          existingTag.score = parseFloat(item.score);
          existingTag.source = data.provider;

          await this.trendingTagRepository.save(existingTag);
          results.updated++;
          this.logger.debug(`Updated trending tag: ${normalizedTag}`);
        } else {
          // Create new trending tag
          const trendingTag = this.trendingTagRepository.create({
            tag: normalizedTag,
            score: parseFloat(item.score),
            source: data.provider,
            description: null,
          });

          await this.trendingTagRepository.save(trendingTag);
          results.created++;
          this.logger.debug(`Created trending tag: ${normalizedTag}`);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        results.errors.push(
          `Error processing tag "${item.tag}": ${errorMessage}`,
        );
        this.logger.error(
          `Error creating trending tag for "${item.tag}"`,
          error,
        );
      }
    }

    return results;
  }
}

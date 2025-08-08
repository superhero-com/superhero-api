import { PULL_TRENDING_TAGS_ENABLED } from '@/configs/constants';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TrendingTag } from '../entities/trending-tags.entity';
import { CreateTrendingTagsDto } from '../dto/create-trending-tags.dto';
import { TokensService } from '@/tokens/tokens.service';

@Injectable()
export class TrendingTagsService {
  private readonly logger = new Logger(TrendingTagsService.name);

  constructor(
    @InjectRepository(TrendingTag)
    private readonly trendingTagRepository: Repository<TrendingTag>,
    private readonly tokensService: TokensService,
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
   * Process and normalize tag name according to business rules:
   * - Convert to uppercase
   * - Remove special characters (only A-Z, 0-9 allowed)
   * - Convert camelCase to kebab-case
   */
  private normalizeTag(tag: string): string {
    // First, convert camelCase to kebab-case
    const kebabCase = tag.replace(/([a-z])([A-Z])/g, '$1-$2');

    // Convert to uppercase and remove all special characters except alphanumeric and hyphens
    const normalized = kebabCase.toUpperCase().replace(/[^A-Z0-9-]/g, '');

    // Clean up multiple hyphens and leading/trailing hyphens
    return normalized.replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  /**
   * Create trending tags from external provider data
   */
  async createTrendingTags(
    data: CreateTrendingTagsDto,
  ): Promise<{ created: number; skipped: number; errors: string[] }> {
    const results = {
      created: 0,
      skipped: 0,
      errors: [] as string[],
    };

    for (const item of data.items) {
      try {
        const normalizedTag = this.normalizeTag(item.tag);

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
          results.skipped++;
          this.logger.debug(`Tag "${normalizedTag}" already exists, skipping`);
          continue;
        }

        const token =
          await this.tokensService.findByNameOrSymbol(normalizedTag);

        // Create new trending tag
        const trendingTag = this.trendingTagRepository.create({
          tag: normalizedTag,
          score: parseFloat(item.score),
          source: data.provider,
          description: null,
          token_sale_address: token?.sale_address || null,
        });

        await this.trendingTagRepository.save(trendingTag);
        results.created++;
        this.logger.debug(`Created trending tag: ${normalizedTag}`);
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

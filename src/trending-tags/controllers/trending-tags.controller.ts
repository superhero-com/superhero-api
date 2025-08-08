import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiSecurity,
  ApiBody,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { paginate } from 'nestjs-typeorm-paginate';
import { Repository } from 'typeorm';
import { TrendingTag } from '../entities/trending-tags.entity';
import { CreateTrendingTagsDto } from '../dto/create-trending-tags.dto';
import { TrendingTagsService } from '../services/trending-tags.service';
import { ApiKeyGuard } from '../guards/api-key.guard';

@Controller('trending-tags')
@ApiTags('Trending Tags')
export class TrendingTagsController {
  constructor(
    @InjectRepository(TrendingTag)
    private readonly trendingTagRepository: Repository<TrendingTag>,
    private readonly trendingTagsService: TrendingTagsService,
  ) {
    //
  }

  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'order_by',
    enum: ['score', 'source', 'token_sale_address', 'created_at'],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiOperation({ operationId: 'listAll' })
  @Get()
  async listAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'score',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
  ) {
    const query = this.trendingTagRepository.createQueryBuilder('trending_tag');
    if (orderBy) {
      query.orderBy(`trending_tag.${orderBy}`, orderDirection);
    }
    return paginate(query, { page, limit });
  }

  // single trending tag
  @ApiOperation({ operationId: 'getTrendingTag' })
  @ApiParam({ name: 'tag', type: 'string' })
  @Get(':tag')
  async getTrendingTag(@Param('tag') tag: string) {
    const trendingTag = await this.trendingTagRepository.findOne({
      where: { tag },
    });

    if (!trendingTag) {
      throw new NotFoundException('Trending tag not found');
    }

    return trendingTag;
  }

  @Post()
  @UseGuards(ApiKeyGuard)
  @ApiOperation({
    operationId: 'createTrendingTags',
    summary: 'Create trending tags from external provider',
    description:
      'Creates trending tags from external provider data. Tags are normalized (uppercase, alphanumeric only, camelCase to kebab-case) and duplicates are skipped.',
  })
  @ApiSecurity('api-key')
  @ApiBody({
    type: CreateTrendingTagsDto,
    description: 'Trending tags data from external provider',
  })
  async createTrendingTags(
    @Body() createTrendingTagsDto: CreateTrendingTagsDto,
  ) {
    const results = await this.trendingTagsService.createTrendingTags(
      createTrendingTagsDto,
    );

    return {
      message: 'Trending tags processing completed',
      results: {
        created: results.created,
        skipped: results.skipped,
        total_processed: createTrendingTagsDto.items.length,
        errors: results.errors,
      },
    };
  }
}

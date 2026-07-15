import {
  BadRequestException,
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
import { normalizeTagName } from '../utils/tag-name.util';
import { ApiKeyGuard } from '../guards/api-key.guard';
import { TopicParamPipe } from '@/common/validation/request-validation';

const ALLOWED_ORDER_BY = new Set(['score', 'source', 'created_at']);
const ALLOWED_ORDER_DIRECTIONS = new Set(['ASC', 'DESC']);
const MAX_SEARCH_LENGTH = 100;

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

  @ApiQuery({ name: 'search', type: 'string', required: false })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'order_by',
    enum: ['score', 'source', 'created_at'],
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
    @Query('search') search: string = '',
  ) {
    if (page < 1) {
      throw new BadRequestException('Page must be greater than or equal to 1');
    }
    if (limit < 1 || limit > 100) {
      throw new BadRequestException('Limit must be between 1 and 100');
    }
    if (!ALLOWED_ORDER_BY.has(orderBy)) {
      throw new BadRequestException(`Invalid order_by value: ${orderBy}`);
    }
    if (!ALLOWED_ORDER_DIRECTIONS.has(orderDirection)) {
      throw new BadRequestException(
        `Invalid order_direction value: ${orderDirection}`,
      );
    }
    if (search && search.length > MAX_SEARCH_LENGTH) {
      throw new BadRequestException(
        `search must be at most ${MAX_SEARCH_LENGTH} characters`,
      );
    }
    const query = this.trendingTagRepository.createQueryBuilder('trending_tag');
    if (orderBy) {
      query.orderBy(`trending_tag.${orderBy}`, orderDirection);
    }
    if (search) {
      query.where('trending_tag.tag ILIKE :search', {
        search: `%${search}%`,
      });
    }

    // left join token by trending.tag = token.tag
    query.leftJoinAndMapOne(
      'trending_tag.token',
      'token',
      'token',
      'token.name = trending_tag.tag',
    );
    return paginate(query, { page, limit });
  }

  // single trending tag
  @ApiOperation({ operationId: 'getTrendingTag' })
  @ApiParam({ name: 'tag', type: 'string' })
  @Get(':tag')
  async getTrendingTag(@Param('tag', TopicParamPipe) tag: string) {
    const trendingTag = await this.trendingTagRepository.findOne({
      where: { tag: normalizeTagName(tag) },
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
    summary: 'Create or update trending tags from external provider',
    description:
      'Creates new trending tags or updates existing ones from external provider data. Tags are normalized (uppercase, alphanumeric only, camelCase to kebab-case). Existing tags are updated with new scores and token associations.',
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
        updated: results.updated,
        total_processed: createTrendingTagsDto.items.length,
        errors: results.errors,
      },
    };
  }
}

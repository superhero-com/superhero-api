import {
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiOkResponse,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { paginate } from 'nestjs-typeorm-paginate';
import { Repository } from 'typeorm';
import { Post } from '../entities/post.entity';
import { PopularRankingService } from '../services/popular-ranking.service';
import { PostDto } from '../dto';
import type { Request } from 'express';
import { ReadsService } from '../services/reads.service';
import { ApiOkResponsePaginated } from '@/utils/api-type';
import { Token } from '@/tokens/entities/token.entity';
import { TokenPerformanceView } from '@/tokens/entities/tokens-performance.view';

@Controller('posts')
@ApiTags('Posts')
export class PostsController {
  constructor(
    @InjectRepository(Post)
    private readonly postRepository: Repository<Post>,
    private readonly popularRankingService: PopularRankingService,
    private readonly readsService: ReadsService,
  ) {
    //
  }

  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({ name: 'max', type: 'number', required: false, description: 'Max candidates to score (window=all defaults higher)' })
  @ApiQuery({
    name: 'order_by',
    enum: ['total_comments', 'created_at'],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiQuery({
    name: 'search',
    type: 'string',
    required: false,
    description: 'Search term to filter posts by content or topics',
  })
  @ApiQuery({
    name: 'account_address',
    type: 'string',
    required: false,
    description: 'Filter posts by account address',
  })
  @ApiQuery({
    name: 'topics',
    type: 'string',
    required: false,
    description:
      'Filter posts by topic names (comma-separated, partial matching)',
  })
  @ApiOperation({
    operationId: 'listAll',
    summary: 'Get all posts',
    description:
      'Retrieve a paginated list of all posts with optional sorting and search functionality',
  })
  @ApiOkResponsePaginated(PostDto)
  @Get()
  async listAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'created_at',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
    @Query('search') search?: string,
    @Query('account_address') account_address?: string,
    @Query('topics') topics?: string,
  ) {
    const query = this.postRepository
      .createQueryBuilder('post')
      .leftJoinAndSelect('post.topics', 'topic')
      .leftJoinAndMapOne(
        'topic.token',
        Token,
        'token',
        'UPPER(topic.name) = UPPER(token.symbol) AND token.unlisted = false',
      )
      .leftJoinAndMapOne(
        'token.performance',
        TokenPerformanceView,
        'token_performance_view',
        'token.sale_address = token_performance_view.sale_address',
      )
      .where('post.is_hidden = false');

    // Add search functionality
    if (search) {
      const searchTerm = `%${search}%`;
      query.andWhere(
        '(post.content ILIKE :searchTerm OR topic.name ILIKE :searchTerm)',
        { searchTerm },
      );
    }

    if (account_address) {
      query.andWhere('post.sender_address = :account_address', {
        account_address,
      });
    }

    // Add topic filtering (search-like)
    if (topics) {
      const topicNames = topics
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      if (topicNames.length > 0) {
        // Use ILIKE for case-insensitive partial matching
        const topicConditions = topicNames
          .map((_, index) => `topic.name ILIKE :topicSearch${index}`)
          .join(' OR ');

        const topicParams = {};
        topicNames.forEach((topicName, index) => {
          topicParams[`topicSearch${index}`] = `%${topicName}%`;
        });

        query.andWhere(`(${topicConditions})`, topicParams);
      }
    }

    // Add ordering
    if (orderBy) {
      query.orderBy(`post.${orderBy}`, orderDirection);
    }

    return paginate(query, { page, limit });
  }

  @ApiQuery({ name: 'window', enum: ['24h', '7d', 'all'], required: false })
  @ApiQuery({ name: 'debug', type: 'number', required: false, description: 'Return feature breakdown when set to 1' })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiOperation({
    operationId: 'popular',
    summary: 'Popular posts',
    description: 'Returns popular posts for selected time window. Views are ignored in v1.',
  })
  @ApiOkResponsePaginated(PostDto)
  @Get('popular')
  async popular(
    @Query('window') window: '24h' | '7d' | 'all' = '24h',
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit = 50,
    @Query('max') max?: string,
    @Query('debug') debug?: number,
  ) {
    const offset = (page - 1) * limit;
    const maxCandidates = max ? Math.max(1, Math.min(50000, parseInt(max, 10) || 0)) : undefined;
    const posts = await this.popularRankingService.getPopularPosts(window, limit, offset, maxCandidates);
    // Attempt to get total from Redis ZCARD; if unavailable, approximate with page size
    const totalItems = await this.popularRankingService['redis'].zcard(
      (this.popularRankingService as any)['getRedisKey'](window),
    );

    const totalPages = totalItems ? Math.ceil(totalItems / limit) : undefined;
    const response: any = {
      items: posts,
      meta: {
        itemCount: posts.length,
        totalItems,
        totalPages,
        currentPage: page,
      },
    };
    if (debug === 1) {
      response.debug = await (this.popularRankingService as any).explain(window, limit, offset);
    }
    return response;
  }

  @ApiParam({ name: 'id', type: 'string', description: 'Post ID' })
  @ApiOperation({
    operationId: 'getById',
    summary: 'Get post by ID',
    description: 'Retrieve a specific post by its unique identifier',
  })
  @ApiOkResponse({
    type: PostDto,
    description: 'Post retrieved successfully',
  })
  @Get(':id')
  async getById(@Param('id') id: string, @Req() req: Request) {
    const post = await this.postRepository.findOne({
      where: { id },
    });
    if (!post) {
      throw new NotFoundException(`Post with ID ${id} not found`);
    }
    // fire-and-forget: do not block response
    void this.readsService.recordRead(post.id, req);
    return post;
  }

  @ApiParam({ name: 'id', type: 'string', description: 'Post ID' })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiOperation({
    operationId: 'getComments',
    summary: 'Get comments for a post',
    description: 'Retrieve paginated comments for a specific post',
  })
  @ApiOkResponsePaginated(PostDto)
  @Get(':id/comments')
  async getComments(
    @Param('id') id: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit = 50,
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'ASC',
  ) {
    // First check if the parent post exists
    const parentPost = await this.postRepository.findOne({
      where: { id },
    });
    if (!parentPost) {
      throw new NotFoundException(`Post with ID ${id} not found`);
    }

    const query = this.postRepository
      .createQueryBuilder('post')
      .where('post.post_id = :parentPostId', { parentPostId: id })
      .orderBy('post.created_at', orderDirection);

    return paginate(query, { page, limit });
  }
}

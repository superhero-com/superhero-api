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
    // Build base query for filtering to get distinct post IDs
    // This prevents duplicates when posts have multiple topics
    const baseQuery = this.postRepository
      .createQueryBuilder('post')
      .leftJoin('post.topics', 'topic')
      .where('post.is_hidden = false');

    // Add search functionality
    if (search) {
      const searchTerm = `%${search}%`;
      baseQuery.andWhere(
        '(post.content ILIKE :searchTerm OR topic.name ILIKE :searchTerm)',
        { searchTerm },
      );
    }

    if (account_address) {
      baseQuery.andWhere('post.sender_address = :account_address', {
        account_address,
      });
    }

    // Add topic filtering
    if (topics) {
      const topicNames = topics
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      if (topicNames.length > 0) {
        const topicConditions = topicNames
          .map((_, index) => `topic.name ILIKE :topicSearch${index}`)
          .join(' OR ');

        const topicParams = {};
        topicNames.forEach((topicName, index) => {
          topicParams[`topicSearch${index}`] = `%${topicName}%`;
        });

        baseQuery.andWhere(`(${topicConditions})`, topicParams);
      }
    }

    // Get distinct post IDs using groupBy with aggregate to prevent duplicates
    // Execute the subquery first with pagination to get the IDs, then use them in the main query
    const orderColumn = orderBy || 'created_at';
    // Use MIN/MAX aggregate to get one value per post.id for ordering
    const aggregateFn = orderDirection === 'DESC' ? 'MAX' : 'MIN';
    
    // Calculate offset for pagination
    const offset = (page - 1) * limit;
    
    // Execute subquery to get distinct post IDs with pagination
    const distinctPostIds = await baseQuery
      .select('post.id', 'id')
      .addSelect(`${aggregateFn}(post.${orderColumn})`, 'order_value')
      .groupBy('post.id')
      .orderBy('order_value', orderDirection)
      .offset(offset)
      .limit(limit)
      .getRawMany<{ id: string }>();

    // If no posts found, return empty result
    if (distinctPostIds.length === 0) {
      return paginate(
        this.postRepository.createQueryBuilder('post').where('1=0'),
        { page, limit },
      );
    }

    const postIds = distinctPostIds.map((p) => p.id);

    // Get total count for pagination metadata
    // We need to count distinct posts matching the filters
    const totalCountQuery = this.postRepository
      .createQueryBuilder('post')
      .leftJoin('post.topics', 'topic')
      .where('post.is_hidden = false');
    
    if (search) {
      const searchTerm = `%${search}%`;
      totalCountQuery.andWhere(
        '(post.content ILIKE :searchTerm OR topic.name ILIKE :searchTerm)',
        { searchTerm },
      );
    }
    
    if (account_address) {
      totalCountQuery.andWhere('post.sender_address = :account_address', {
        account_address,
      });
    }
    
    if (topics) {
      const topicNames = topics
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      if (topicNames.length > 0) {
        const topicConditions = topicNames
          .map((_, index) => `topic.name ILIKE :topicSearch${index}`)
          .join(' OR ');
        const topicParams = {};
        topicNames.forEach((topicName, index) => {
          topicParams[`topicSearch${index}`] = `%${topicName}%`;
        });
        totalCountQuery.andWhere(`(${topicConditions})`, topicParams);
      }
    }
    
    const totalCount = await totalCountQuery
      .select('COUNT(DISTINCT post.id)', 'count')
      .getRawOne<{ count: string }>();
    const totalItems = parseInt(totalCount?.count || '0', 10);

    // Now build the main query that joins topics and other relations
    // Filter by the distinct post IDs
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
      .where('post.id IN (:...postIds)', { postIds })
      .orderBy(`post.${orderColumn}`, orderDirection);

    // Execute the main query
    const items = await query.getMany();
    
    // Return paginated result
    return {
      items,
      meta: {
        itemCount: items.length,
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
        currentPage: page,
      },
    };
  }

  @ApiQuery({ name: 'window', enum: ['24h', '7d', 'all'], required: false })
  @ApiQuery({
    name: 'debug',
    type: 'number',
    required: false,
    description: 'Return feature breakdown when set to 1',
  })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiOperation({
    operationId: 'popular',
    summary: 'Popular posts',
    description:
      'Returns popular posts for selected time window. Views are ignored in v1.',
  })
  @ApiOkResponsePaginated(PostDto)
  @Get('popular')
  async popular(
    @Query('window') window: '24h' | '7d' | 'all' = '24h',
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit = 50,
    @Query('debug') debug?: number,
  ) {
    const offset = (page - 1) * limit;
    console.error(`[PostsController] popular endpoint called: window=${window}, page=${page}, limit=${limit}, offset=${offset}`);
    try {
      // Get total count of all posts (not filtered by window)
      // The window only affects which posts are considered "popular" (from Redis)
      const totalItems = await this.popularRankingService.getTotalPostsCount(window);
      const totalPages = Math.ceil(totalItems / limit);
      console.error(`[PostsController] totalItems=${totalItems}, totalPages=${totalPages}`);
      
      const posts = await this.popularRankingService.getPopularPosts(
        window,
        limit,
        offset,
      );
      console.error(`[PostsController] getPopularPosts returned ${posts.length} posts`);
      
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
        response.debug = await (this.popularRankingService as any).explain(
          window,
          limit,
          offset,
        );
      }
      return response;
    } catch (error) {
      const items = await this.postRepository
        .createQueryBuilder('post')
        .where('post.is_hidden = false')
        .andWhere('post.post_id IS NULL')
        .orderBy('post.created_at', 'DESC')
        .offset(offset)
        .limit(limit)
        .getMany();
      return {
        items,
        meta: {
          itemCount: items.length,
          totalItems: undefined,
          totalPages: undefined,
          currentPage: page,
          fallback: true,
          error:
            'Popular ranking temporarily unavailable; returned recent posts',
        },
      };
    }
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
    const post = await this.postRepository
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
      .where('(post.id = :id OR post.slug = :id)', { id })
      .getOne();

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

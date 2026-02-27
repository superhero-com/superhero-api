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
import { PopularRankingContentItem } from '@/plugins/popular-ranking.interface';
import { extractTrendMentions } from '../utils/content-parser.util';
import { Account } from '@/account/entities/account.entity';

@Controller('posts')
@ApiTags('Posts')
export class PostsController {
  constructor(
    @InjectRepository(Post)
    private readonly postRepository: Repository<Post>,
    @InjectRepository(Token)
    private readonly tokenRepository: Repository<Token>,
    private readonly popularRankingService: PopularRankingService,
    private readonly readsService: ReadsService,
  ) {
    //
  }

  private async attachTrendMentionsPerformance(
    items: Array<{ id: string; content: string }>,
  ): Promise<void> {
    const mentionsByPost = new Map<string, string[]>();
    const mentionedSymbols = new Set<string>();

    for (const item of items) {
      if (!item?.id || !item?.content) {
        continue;
      }
      const mentions = extractTrendMentions(item.content);
      if (mentions.length === 0) {
        continue;
      }
      mentionsByPost.set(item.id, mentions);
      mentions.forEach((name) => mentionedSymbols.add(name));
    }

    if (mentionedSymbols.size === 0) {
      return;
    }

    const tokens = await this.tokenRepository
      .createQueryBuilder('token')
      .leftJoinAndMapOne(
        'token.performance',
        TokenPerformanceView,
        'token_performance_view',
        'token.sale_address = token_performance_view.sale_address',
      )
      .where('token.unlisted = false')
      .andWhere('UPPER(token.symbol) IN (:...names)', {
        names: [...mentionedSymbols],
      })
      .orderBy('token.created_at', 'DESC')
      .getMany();

    const tokensBySymbol = new Map<
      string,
      Token & { performance?: TokenPerformanceView }
    >();
    for (const token of tokens) {
      if (token?.symbol) {
        const key = token.symbol.toUpperCase();
        if (!tokensBySymbol.has(key)) {
          tokensBySymbol.set(key, token as any);
        }
      }
    }

    for (const item of items) {
      const names = mentionsByPost.get(item.id);
      if (!names) {
        continue;
      }
      (item as any).trend_mentions = names.map((name) => {
        const token = tokensBySymbol.get(name);
        return {
          name,
          sale_address: token?.sale_address ?? null,
          performance: token?.performance
            ? {
                past_24h: token.performance.past_24h ?? null,
                past_7d: token.performance.past_7d ?? null,
              }
            : null,
        };
      });
    }
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
    @Query('limit', new DefaultValuePipe(30), ParseIntPipe) limit = 30,
    @Query('order_by') orderBy: string = 'created_at',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
    @Query('search') search?: string,
    @Query('account_address') account_address?: string,
    @Query('topics') topics?: string,
  ) {
    limit = Math.min(limit, 30);
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
      .getRawMany<{ id: string; order_value: any }>();

    // If no posts found, return empty result
    if (distinctPostIds.length === 0) {
      return paginate(
        this.postRepository.createQueryBuilder('post').where('1=0'),
        { page, limit },
      );
    }

    // Preserve the order from the pagination query
    // Create a map of postId -> index to maintain pagination order
    const postIds = distinctPostIds.map((p) => p.id);
    const postIdOrder = new Map<string, number>();
    distinctPostIds.forEach((p, index) => {
      postIdOrder.set(p.id, index);
    });

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
        'post.sender',
        Account,
        'account',
        'account.address = post.sender_address',
      )
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
      .where('post.id IN (:...postIds)', { postIds });
    // Note: We don't use orderBy here because SQL IN clauses don't preserve order
    // Instead, we'll sort in memory to preserve the pagination order

    // Execute the main query
    const items = await query.getMany();

    // Sort items to match the order from the pagination query
    // This preserves the pagination integrity and prevents duplicates/skips across pages
    items.sort((a, b) => {
      const aIndex = postIdOrder.get(a.id) ?? Infinity;
      const bIndex = postIdOrder.get(b.id) ?? Infinity;
      return aIndex - bIndex;
    });

    await this.attachTrendMentionsPerformance(items);

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
    try {
      // Get total count of popular posts for the given window
      const totalItems =
        await this.popularRankingService.getTotalPostsCount(window);
      const totalPages = Math.ceil(totalItems / limit);

      const items = await this.popularRankingService.getPopularPosts(
        window,
        limit,
        offset,
      );

      // Transform items to include type discriminator
      const transformedItems = items.map((item) => {
        if ('type' in item && item.type !== 'post' && 'metadata' in item) {
          // Plugin content item (e.g., poll)
          const pluginItem = item as PopularRankingContentItem;
          return {
            ...pluginItem,
            type: pluginItem.type,
            // Ensure it has all required PostDto fields for compatibility
            id: pluginItem.id,
            created_at: pluginItem.created_at,
            sender_address: pluginItem.sender_address,
            content: pluginItem.content,
            total_comments: pluginItem.total_comments,
            ...(pluginItem.metadata !== undefined && {
              metadata: pluginItem.metadata,
            }),
          };
        }
        // Regular post
        return {
          ...item,
          type: 'post',
        };
      });

      await this.attachTrendMentionsPerformance(
        transformedItems as Array<{ id: string; content: string }>,
      );

      const response: any = {
        items: transformedItems,
        meta: {
          itemCount: transformedItems.length,
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
      .leftJoinAndMapOne(
        'post.sender',
        Account,
        'account',
        'account.address = post.sender_address',
      )
      .where('(post.id = :id OR post.slug = :id)', { id })
      .getOne();

    if (!post) {
      throw new NotFoundException(`Post with ID ${id} not found`);
    }
    await this.attachTrendMentionsPerformance([post]);
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

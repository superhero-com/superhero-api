import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { Post } from '@/social/entities/post.entity';
import { Token } from '@/tokens/entities/token.entity';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { PopularRankingService } from '@/social/services/popular-ranking.service';
import {
  FeedSort,
  LatestFeedCursor,
  decodeFeedCursor,
  encodeFeedCursor,
} from './feed-cursor.util';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const VALID_SORTS = new Set<FeedSort>(['latest', 'hot']);

type FeedItemType = 'post' | 'token_created' | 'trade';

interface FeedItem {
  type: FeedItemType;
  created_at: Date;
  data: unknown;
}

// Replaces the frontend's separate posts + token-creations + trades fetches
// (deduped/merged/sorted client-side) with one keyset-paginated feed.
@Controller('feed')
@ApiTags('Feed')
@UseInterceptors(CacheInterceptor)
export class FeedController {
  constructor(
    @InjectRepository(Post)
    private readonly postsRepository: Repository<Post>,

    @InjectRepository(Token)
    private readonly tokensRepository: Repository<Token>,

    @InjectRepository(Transaction)
    private readonly transactionsRepository: Repository<Transaction>,

    private readonly popularRankingService: PopularRankingService,
  ) {
    //
  }

  @ApiOperation({
    operationId: 'getFeed',
    summary: 'Combined home feed',
    description:
      'Keyset-paginated UNION of posts, token creations, and trades for ' +
      '`sort=latest`. `sort=hot` returns posts only, ranked by the existing ' +
      'popular-ranking algorithm (trades and token creations are never ' +
      'ranked under "Hot").',
  })
  @ApiQuery({ name: 'sort', enum: ['latest', 'hot'], required: false })
  @ApiQuery({ name: 'cursor', type: 'string', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiOkResponse({
    description: '{ items: [{ type, created_at, data }], next_cursor }',
  })
  @CacheTTL(15_000)
  @Get()
  async getFeed(
    @Query('sort') sortParam: string = 'latest',
    @Query('cursor') cursorParam?: string,
    @Query('limit', new DefaultValuePipe(DEFAULT_LIMIT), ParseIntPipe)
    limit = DEFAULT_LIMIT,
  ): Promise<{ items: FeedItem[]; next_cursor: string | null }> {
    if (!VALID_SORTS.has(sortParam as FeedSort)) {
      throw new BadRequestException('sort must be one of: latest, hot');
    }
    const sort = sortParam as FeedSort;
    const clampedLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);
    const cursor = decodeFeedCursor(cursorParam, sort);

    if (sort === 'hot') {
      return this.getHotFeed(
        cursor?.sort === 'hot' ? cursor.offset : 0,
        clampedLimit,
      );
    }

    return this.getLatestFeed(
      cursor?.sort === 'latest' ? cursor : null,
      clampedLimit,
    );
  }

  private async getHotFeed(
    offset: number,
    limit: number,
  ): Promise<{ items: FeedItem[]; next_cursor: string | null }> {
    const { items, totalItems } =
      await this.popularRankingService.getPopularPostsPage(
        'all',
        limit,
        offset,
      );

    const feedItems: FeedItem[] = items.map((item) => ({
      type: 'post',
      created_at: item.created_at,
      data: item,
    }));

    const nextOffset = offset + items.length;
    const nextCursor =
      items.length > 0 && nextOffset < totalItems
        ? encodeFeedCursor({ sort: 'hot', offset: nextOffset })
        : null;

    return { items: feedItems, next_cursor: nextCursor };
  }

  private async getLatestFeed(
    cursor: LatestFeedCursor | null,
    limit: number,
  ): Promise<{ items: FeedItem[]; next_cursor: string | null }> {
    const before = cursor ? new Date(cursor.ts) : null;
    const excludeIds = cursor?.seenIds ?? [];

    const [posts, tokens, trades] = await Promise.all([
      this.fetchPosts(before, limit, excludeIds),
      this.fetchTokenCreations(before, limit, excludeIds),
      this.fetchTrades(before, limit, excludeIds),
    ]);

    const candidates: FeedItem[] = [
      ...posts.map(
        (post): FeedItem => ({
          type: 'post',
          created_at: post.created_at,
          data: post,
        }),
      ),
      ...tokens.map(
        (token): FeedItem => ({
          type: 'token_created',
          created_at: token.created_at,
          data: token,
        }),
      ),
      ...trades.map(
        (trade): FeedItem => ({
          type: 'trade',
          created_at: trade.created_at,
          data: trade,
        }),
      ),
    ].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

    const items = candidates.slice(0, limit);
    // Any candidate fetched but not surfaced this page (either because a
    // source alone hit its own `limit` cap, or the merged pool exceeded
    // `limit`) means there is more to page through.
    const hasMore =
      candidates.length > items.length ||
      posts.length === limit ||
      tokens.length === limit ||
      trades.length === limit;

    const lastItem = items[items.length - 1];
    let nextCursor: string | null = null;
    if (lastItem && hasMore) {
      const cutoff = lastItem.created_at.getTime();
      const idsAtCutoffThisPage = items
        .filter((item) => item.created_at.getTime() === cutoff)
        .map((item) => getFeedItemId(item));
      // If the tie at `cutoff` spans more than one page (more items share
      // this exact timestamp than fit in `limit`), the cutoff stays the same
      // across pages -- carry forward every id already excluded so far, or a
      // later page would stop excluding earlier pages' ids and re-serve
      // them. A cutoff that moved past the tie starts a fresh exclusion set:
      // the strict `created_at < cutoff` filter alone already excludes
      // everything at the old (later) timestamp.
      const seenIds =
        cursor && cursor.ts === cutoff
          ? [...new Set([...(cursor.seenIds ?? []), ...idsAtCutoffThisPage])]
          : idsAtCutoffThisPage;
      nextCursor = encodeFeedCursor({ sort: 'latest', ts: cutoff, seenIds });
    }

    return { items, next_cursor: nextCursor };
  }

  private fetchPosts(
    before: Date | null,
    limit: number,
    excludeIds: string[],
  ): Promise<Post[]> {
    const query = this.postsRepository
      .createQueryBuilder('post')
      .where('post.is_hidden = false')
      .orderBy('post.created_at', 'DESC')
      .limit(limit);
    applyCursorFilter(query, 'post.created_at', 'post.id', before, excludeIds);
    return query.getMany();
  }

  private fetchTokenCreations(
    before: Date | null,
    limit: number,
    excludeIds: string[],
  ): Promise<Token[]> {
    const query = this.tokensRepository
      .createQueryBuilder('token')
      .where('token.unlisted = false')
      .orderBy('token.created_at', 'DESC')
      .limit(limit);
    applyCursorFilter(
      query,
      'token.created_at',
      'token.sale_address',
      before,
      excludeIds,
    );
    return query.getMany();
  }

  private fetchTrades(
    before: Date | null,
    limit: number,
    excludeIds: string[],
  ): Promise<Transaction[]> {
    const query = this.transactionsRepository
      .createQueryBuilder('transaction')
      .innerJoin(
        Token,
        'token',
        'token.sale_address = transaction.sale_address AND token.unlisted = false',
      )
      .where("transaction.tx_type IN ('buy', 'sell')")
      .orderBy('transaction.created_at', 'DESC')
      .limit(limit);
    applyCursorFilter(
      query,
      'transaction.created_at',
      'transaction.tx_hash',
      before,
      excludeIds,
    );
    return query.getMany();
  }
}

function getFeedItemId(item: FeedItem): string {
  switch (item.type) {
    case 'post':
      return (item.data as Post).id;
    case 'token_created':
      return (item.data as Token).sale_address;
    case 'trade':
      return (item.data as Transaction).tx_hash;
  }
}

// created_at < before OR (created_at = before AND <pk> NOT IN (excludeIds)):
// the first page (no `before`) needs no filter at all. When there is nothing
// to exclude (the overwhelmingly common case -- an exact tie at the cutoff
// is rare), this stays the plain `created_at < before` filter; the OR branch
// only appears when a previous page actually returned tied items, so it
// isn't skipped or re-served on the next page.
function applyCursorFilter(
  query: { andWhere: (...args: any[]) => any },
  createdAtColumn: string,
  pkColumn: string,
  before: Date | null,
  excludeIds: string[],
): void {
  if (!before) {
    return;
  }
  if (!excludeIds.length) {
    query.andWhere(`${createdAtColumn} < :before`, { before });
    return;
  }
  query.andWhere(
    new Brackets((qb) => {
      qb.where(`${createdAtColumn} < :before`, { before }).orWhere(
        new Brackets((qb2) => {
          qb2
            .where(`${createdAtColumn} = :before`, { before })
            .andWhere(`${pkColumn} NOT IN (:...excludeIds)`, { excludeIds });
        }),
      );
    }),
  );
}

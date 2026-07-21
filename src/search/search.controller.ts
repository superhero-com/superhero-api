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
  ApiProperty,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Token } from '@/tokens/entities/token.entity';
import { Post } from '@/social/entities/post.entity';
import { AccountService } from '@/account/services/account.service';
import { AccountSearchResultDto } from '@/account/dto/account-search-result.dto';
import { TokenDto } from '@/tokens/dto/token.dto';
import { PostDto } from '@/social/dto/post.dto';

const MAX_QUERY_LENGTH = 100;
const MIN_QUERY_LENGTH = 2;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

// Swagger documentation shape only. Handlers below return raw entities
// (Token/Post) rather than instances of TokenDto/PostDto, matching this
// codebase's existing pattern elsewhere (e.g. tokens.controller.ts's
// `@ApiOkResponsePaginated(TokenDto)` over raw query rows).
class SearchResultDto {
  @ApiProperty({ type: () => TokenDto, isArray: true })
  tokens: TokenDto[];

  @ApiProperty({ type: () => AccountSearchResultDto, isArray: true })
  accounts: AccountSearchResultDto[];

  @ApiProperty({ type: () => PostDto, isArray: true })
  posts: PostDto[];
}

interface SearchResult {
  tokens: Token[];
  accounts: AccountSearchResultDto[];
  posts: Post[];
}

// Replaces 3 separate debounced-keystroke requests (tokens, accounts, posts)
// with one server-side fan-out, so the client fires a single request per
// keystroke instead of three.
@Controller('search')
@ApiTags('Search')
@UseInterceptors(CacheInterceptor)
export class SearchController {
  constructor(
    @InjectRepository(Token)
    private readonly tokensRepository: Repository<Token>,

    @InjectRepository(Post)
    private readonly postsRepository: Repository<Post>,

    private readonly accountService: AccountService,
  ) {
    //
  }

  @ApiOperation({
    operationId: 'search',
    summary: 'Unified search across tokens, accounts, and posts',
    description:
      'Runs the token/account/post lookups in parallel server-side, each ' +
      `capped at \`limit\`. Returns empty arrays for \`q\` shorter than ${MIN_QUERY_LENGTH} characters.`,
  })
  @ApiQuery({
    name: 'q',
    type: 'string',
    required: true,
    description: `Search term, max ${MAX_QUERY_LENGTH} characters.`,
  })
  @ApiQuery({
    name: 'limit',
    type: 'number',
    required: false,
    description: 'Max results per category, clamped to 1-20 (default 5).',
  })
  @ApiOkResponse({ type: SearchResultDto })
  @CacheTTL(30_000)
  @Get()
  async search(
    @Query('q') q: string | undefined,
    @Query('limit', new DefaultValuePipe(DEFAULT_LIMIT), ParseIntPipe)
    limit = DEFAULT_LIMIT,
  ): Promise<SearchResult> {
    if (q && q.length > MAX_QUERY_LENGTH) {
      throw new BadRequestException(
        `q must be at most ${MAX_QUERY_LENGTH} characters`,
      );
    }

    const term = (q ?? '').trim();
    const clampedLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);

    if (term.length < MIN_QUERY_LENGTH) {
      return { tokens: [], accounts: [], posts: [] };
    }

    const [tokens, accounts, posts] = await Promise.all([
      this.searchTokens(term, clampedLimit),
      this.accountService.searchByNameOrAddress(term, clampedLimit),
      this.searchPosts(term, clampedLimit),
    ]);

    return { tokens, accounts, posts };
  }

  private searchTokens(term: string, limit: number): Promise<Token[]> {
    return this.tokensRepository
      .createQueryBuilder('token')
      .where('token.unlisted = false')
      .andWhere('token.name ILIKE :term', { term: `%${term}%` })
      .orderBy('token.trending_score', 'DESC')
      .addOrderBy('token.created_at', 'DESC')
      .limit(limit)
      .getMany();
  }

  private searchPosts(term: string, limit: number): Promise<Post[]> {
    return this.postsRepository
      .createQueryBuilder('post')
      .where('post.is_hidden = false')
      .andWhere('post.content ILIKE :term', { term: `%${term}%` })
      .orderBy('post.created_at', 'DESC')
      .limit(limit)
      .getMany();
  }
}

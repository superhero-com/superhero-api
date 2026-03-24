import {
  Controller,
  DefaultValuePipe,
  Get,
  Inject,
  Logger,
  ParseIntPipe,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { fetchJson } from '@/utils/common';
import { GiphyGifDto, GiphySearchResponseDto } from '../dto/giphy.dto';

const GIPHY_API_URL = 'https://api.giphy.com/v1/gifs';
const INFINITEGIF_API_URL = 'https://infinitegif.com/api';
const CACHE_TTL_MS = 60 * 60 * 1000;

function mapGiphyGif(gif: any): GiphyGifDto {
  const images = gif?.images;
  return {
    id: gif.id,
    still: images?.fixed_width_still?.url ?? null,
    animated: images?.fixed_width?.url ?? null,
    mp4:
      images?.fixed_width?.mp4 ??
      images?.downsized_small?.mp4 ??
      images?.original_mp4?.mp4 ??
      null,
    original: images?.original?.url ?? null,
    width: Number(images?.original?.width) || 0,
    height: Number(images?.original?.height) || 0,
  };
}

function isAbsoluteUrl(val: unknown): val is string {
  return typeof val === 'string' && val.startsWith('http');
}

function mapInfiniteGif(gif: any): GiphyGifDto | null {
  const gifUrl = gif?.fileInfo?.gifPath ?? gif?.gifPath ?? null;
  if (!isAbsoluteUrl(gifUrl)) return null;

  const poster = isAbsoluteUrl(gif?.poster) ? gif.poster : gifUrl;
  return {
    id: gif._id,
    still: poster,
    animated: gifUrl,
    mp4: null,
    original: gifUrl,
    width: Number(gif?.fileInfo?.width) || 0,
    height: Number(gif?.fileInfo?.height) || 0,
  };
}

@Controller('giphy')
@ApiTags('Giphy')
export class GiphyController {
  private readonly logger = new Logger(GiphyController.name);

  constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

  @ApiQuery({ name: 'q', type: 'string', required: false, description: 'Search query. Omit for trending GIFs.' })
  @ApiQuery({ name: 'limit', type: 'number', required: false, description: 'Number of results (max 50)' })
  @ApiQuery({ name: 'offset', type: 'number', required: false, description: 'Pagination offset' })
  @ApiOperation({
    operationId: 'giphySearch',
    summary: 'Search or list trending GIFs',
    description:
      'Proxies GIF search/trending via Giphy (when configured) with InfiniteGIF as fallback. Results are cached for 1 hour.',
  })
  @ApiOkResponse({ type: GiphySearchResponseDto })
  @Get('search')
  async search(
    @Query('q') q?: string,
    @Query('limit', new DefaultValuePipe(12), ParseIntPipe) limit = 12,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset = 0,
  ): Promise<GiphySearchResponseDto> {
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const safeOffset = Math.max(offset, 0);
    const endpoint = q ? 'search' : 'trending';
    const cacheKey = `gif:${endpoint}:${q || ''}:${safeLimit}:${safeOffset}`;

    const cached = await this.cacheManager.get<GiphySearchResponseDto>(cacheKey);
    if (cached) return cached;

    const apiKey = process.env.GIPHY_API_KEY;
    let result: GiphySearchResponseDto | null = null;

    if (apiKey) {
      result = await this.fetchFromGiphy(apiKey, q, safeLimit, safeOffset);
    }

    if (!result) {
      result = await this.fetchFromInfiniteGif(q, safeLimit, safeOffset);
    }

    if (!result) {
      throw new ServiceUnavailableException('All GIF providers are currently unavailable');
    }

    await this.cacheManager.set(cacheKey, result, CACHE_TTL_MS);
    return result;
  }

  private async fetchFromGiphy(
    apiKey: string,
    q: string | undefined,
    limit: number,
    offset: number,
  ): Promise<GiphySearchResponseDto | null> {
    const endpoint = q ? 'search' : 'trending';
    const url = new URL(`${GIPHY_API_URL}/${endpoint}`);
    url.searchParams.set('api_key', apiKey);
    if (q) url.searchParams.set('q', q);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));

    try {
      const { data: responseData, pagination } = await fetchJson(url.toString());
      return {
        results: (responseData as any[]).map(mapGiphyGif),
        totalCount: pagination.total_count,
        nextOffset: pagination.offset + pagination.count,
        hasMore: pagination.offset + pagination.count < pagination.total_count,
      };
    } catch (error) {
      this.logger.warn('Giphy API request failed, falling back to InfiniteGIF', error);
      return null;
    }
  }

  private async fetchFromInfiniteGif(
    q: string | undefined,
    limit: number,
    offset: number,
  ): Promise<GiphySearchResponseDto | null> {
    const page = Math.floor(offset / limit) + 1;

    try {
      if (q) {
        const url = new URL(`${INFINITEGIF_API_URL}/search`);
        url.searchParams.set('q', q);
        url.searchParams.set('page', String(page));
        url.searchParams.set('limit', String(limit));

        const data = await fetchJson(url.toString());
        const raw: any[] = data.gifs ?? data.results ?? [];
        const results = raw.map(mapInfiniteGif).filter(Boolean) as GiphyGifDto[];

        return {
          results,
          totalCount: data.total ?? 0,
          nextOffset: offset + results.length,
          hasMore: data.hasMore ?? page < (data.totalPages ?? 1),
        };
      }

      const url = new URL(`${INFINITEGIF_API_URL}/gifs/trending`);
      url.searchParams.set('page', String(page));
      url.searchParams.set('limit', String(limit));

      const data = await fetchJson(url.toString());
      const raw: any[] = data.gifs ?? [];
      const results = raw.map(mapInfiniteGif).filter(Boolean) as GiphyGifDto[];

      return {
        results,
        totalCount: data.total ?? 0,
        nextOffset: offset + results.length,
        hasMore: page < (data.totalPages ?? 1),
      };
    } catch (error) {
      this.logger.error('InfiniteGIF API request failed', error);
      return null;
    }
  }
}

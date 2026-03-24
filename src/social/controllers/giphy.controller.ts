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
import {
  GiphyGifDto,
  GiphySearchResponseDto,
} from '../dto/giphy.dto';

const GIPHY_API_URL = 'https://api.giphy.com/v1/gifs';
const GIPHY_CACHE_TTL_MS = 60 * 60 * 1000;

function mapGif(gif: any): GiphyGifDto {
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
    summary: 'Search or list trending GIFs via Giphy',
    description: 'Proxies Giphy search/trending API so the API key stays server-side. Results are cached for 1 hour.',
  })
  @ApiOkResponse({ type: GiphySearchResponseDto })
  @Get('search')
  async search(
    @Query('q') q?: string,
    @Query('limit', new DefaultValuePipe(12), ParseIntPipe) limit = 12,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset = 0,
  ): Promise<GiphySearchResponseDto> {
    const apiKey = process.env.GIPHY_API_KEY;
    if (!apiKey) {
      throw new ServiceUnavailableException('Giphy integration is not configured');
    }

    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const safeOffset = Math.max(offset, 0);
    const endpoint = q ? 'search' : 'trending';
    const cacheKey = `giphy:${endpoint}:${q || ''}:${safeLimit}:${safeOffset}`;

    const cached = await this.cacheManager.get<GiphySearchResponseDto>(cacheKey);
    if (cached) {
      return cached;
    }

    const url = new URL(`${GIPHY_API_URL}/${endpoint}`);
    url.searchParams.set('api_key', apiKey);
    if (q) url.searchParams.set('q', q);
    url.searchParams.set('limit', String(safeLimit));
    url.searchParams.set('offset', String(safeOffset));

    try {
      const { data: responseData, pagination } = await fetchJson(url.toString());

      const result: GiphySearchResponseDto = {
        results: (responseData as any[]).map(mapGif),
        totalCount: pagination.total_count,
        nextOffset: pagination.offset + pagination.count,
        hasMore: pagination.offset + pagination.count < pagination.total_count,
      };

      await this.cacheManager.set(cacheKey, result, GIPHY_CACHE_TTL_MS);
      return result;
    } catch (error) {
      this.logger.error('Giphy API request failed', error);
      throw new ServiceUnavailableException('Failed to fetch GIFs from Giphy');
    }
  }
}

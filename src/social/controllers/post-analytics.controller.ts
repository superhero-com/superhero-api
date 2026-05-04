import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
  Render,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import moment from 'moment';
import { OptionalAeAccountAddressPipe } from '@/common/validation/request-validation';
import { ProfileReadService } from '@/profile/services/profile-read.service';
import {
  CacheDailyPostAnalyticsService,
  DatePostAnalyticsRow,
} from '../services/cache-daily-post-analytics.service';

@Controller('posts/analytics')
@ApiTags('Posts Analytics')
export class PostAnalyticsController {
  constructor(
    private cacheDailyPostAnalyticsService: CacheDailyPostAnalyticsService,
    private profileReadService: ProfileReadService,
  ) {
    //
  }

  @Get('')
  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiQuery({ name: 'end_date', type: 'string', required: false })
  @ApiQuery({ name: 'sender_address', type: 'string', required: false })
  @ApiOperation({
    operationId: 'getPostsAnalyticsData',
  })
  async getPostsAnalyticsData(
    @Query('start_date') start_date: string,
    @Query('end_date') end_date: string,
    @Query('sender_address', OptionalAeAccountAddressPipe)
    sender_address: string | undefined,
  ): Promise<DatePostAnalyticsRow[]> {
    const startDate = moment(
      start_date ?? moment().subtract(10, 'day').format('YYYY-MM-DD'),
    ).toDate();
    const endDate = moment(end_date ?? moment().format('YYYY-MM-DD')).toDate();

    if (startDate > endDate) {
      throw new BadRequestException('Start date must be before end date');
    }

    // Always use live aggregation: it's a fast indexed query against `posts`,
    // and avoids stale/incomplete results while the cron backfills `post_analytics`.
    return this.cacheDailyPostAnalyticsService.getDateRangeAnalyticsLive(
      startDate,
      endDate,
      sender_address,
    );
  }

  @Get('past-24-hours')
  @ApiQuery({ name: 'sender_address', type: 'string', required: false })
  @ApiOperation({
    operationId: 'getPostsPast24HoursAnalytics',
  })
  async getPast24HoursAnalytics(
    @Query('sender_address', OptionalAeAccountAddressPipe)
    sender_address: string | undefined,
  ) {
    const startDate = moment().subtract(24, 'hours').toDate();
    const endDate = moment().toDate();
    return this.cacheDailyPostAnalyticsService.getDateAnalytics(
      startDate,
      endDate,
      sender_address,
    );
  }

  @Get('top-posters')
  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiQuery({ name: 'end_date', type: 'string', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiOperation({
    operationId: 'getTopPosters',
  })
  async getTopPosters(
    @Query('start_date') start_date: string,
    @Query('end_date') end_date: string,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ) {
    const startDate = moment(
      start_date ?? moment().subtract(10, 'day').format('YYYY-MM-DD'),
    ).toDate();
    const endDate = moment(
      end_date ?? moment().add(1, 'day').format('YYYY-MM-DD'),
    ).toDate();

    if (startDate > endDate) {
      throw new BadRequestException('Start date must be before end date');
    }

    const posters = await this.cacheDailyPostAnalyticsService.getTopPosters(
      startDate,
      endDate,
      limit,
    );

    if (posters.length === 0) {
      return [];
    }

    let profilesByAddress = new Map<string, string>();
    try {
      const profiles = await this.profileReadService.getProfilesByAddresses(
        posters.map((poster) => poster.sender_address),
      );
      profilesByAddress = new Map(
        profiles.map((profile) => [profile.address, profile.public_name]),
      );
    } catch {
      // Profile lookup is best-effort; fall back to address-only display.
    }

    return posters.map((poster) => ({
      ...poster,
      public_name:
        profilesByAddress.get(poster.sender_address) ?? poster.sender_address,
    }));
  }

  @Get('top-topics')
  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiQuery({ name: 'end_date', type: 'string', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiOperation({
    operationId: 'getTopTopics',
  })
  async getTopTopics(
    @Query('start_date') start_date: string,
    @Query('end_date') end_date: string,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ) {
    const startDate = moment(
      start_date ?? moment().subtract(10, 'day').format('YYYY-MM-DD'),
    ).toDate();
    const endDate = moment(
      end_date ?? moment().add(1, 'day').format('YYYY-MM-DD'),
    ).toDate();

    if (startDate > endDate) {
      throw new BadRequestException('Start date must be before end date');
    }

    return this.cacheDailyPostAnalyticsService.getTopTopics(
      startDate,
      endDate,
      limit,
    );
  }

  @Get('preview')
  @Render('posts-analytics')
  root() {
    return { message: 'Posts Analytics Dashboard' };
  }
}

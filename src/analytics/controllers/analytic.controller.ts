import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Render,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { Analytic } from '../entities/analytic.entity';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import moment from 'moment';
import { CacheDailyAnalyticsDataService } from '../services/cache-daily-analytics-data.service';
import { OptionalAeAccountAddressPipe } from '@/common/validation/request-validation';

@Controller('analytics')
@ApiTags('Analytics')
export class AnalyticController {
  constructor(
    @InjectRepository(Analytic)
    private analyticRepository: Repository<Analytic>,

    private cacheDailyAnalyticsDataService: CacheDailyAnalyticsDataService,
  ) {
    //
  }

  @Get('')
  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiQuery({ name: 'end_date', type: 'string', required: false })
  @ApiQuery({ name: 'force_pull', type: 'boolean', required: false })
  @ApiQuery({ name: 'address', type: 'string', required: false })
  @ApiOperation({
    operationId: 'getAnalyticsData',
  })
  async getAnalyticsData(
    @Query('start_date') start_date: string,
    @Query('end_date') end_date: string,
    @Query('force_pull') force_pull: boolean,
    @Query('address', OptionalAeAccountAddressPipe)
    address: string | undefined,
  ) {
    const startDate = moment(
      start_date ?? moment().subtract(10, 'day').format('YYYY-MM-DD'),
    ).toDate();
    const endDate = moment(
      end_date ?? moment().add(1, 'day').format('YYYY-MM-DD'),
    ).toDate();

    // if the dates are not valid, return an error
    if (startDate > endDate) {
      throw new BadRequestException('Start date must be before end date');
    }

    // When filtering by address, always go live so the result reflects the
    // requested user (the cached `analytics` table only stores global aggregates).
    if (address) {
      return this.cacheDailyAnalyticsDataService.getDateRangeAnalyticsLive(
        startDate,
        endDate,
        address,
      );
    }

    if (force_pull) {
      await this.cacheDailyAnalyticsDataService.pullAnalyticsDataByDateRange(
        startDate,
        endDate,
      );
    }
    const analytics = await this.analyticRepository.find({
      where: {
        date: Between(startDate, endDate),
      },
    });
    return analytics;
  }

  @Get('summary')
  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiQuery({ name: 'end_date', type: 'string', required: false })
  @ApiQuery({ name: 'address', type: 'string', required: false })
  @ApiOperation({
    operationId: 'getAnalyticsSummary',
  })
  async getRangeSummary(
    @Query('start_date') start_date: string,
    @Query('end_date') end_date: string,
    @Query('address', OptionalAeAccountAddressPipe)
    address: string | undefined,
  ) {
    const startDate = start_date ? moment(start_date).toDate() : undefined;
    const endDate = end_date ? moment(end_date).toDate() : undefined;

    if (startDate && endDate && startDate > endDate) {
      throw new BadRequestException('Start date must be before end date');
    }

    return this.cacheDailyAnalyticsDataService.getRangeSummary(
      startDate,
      endDate,
      address,
    );
  }

  @Get('past-24-hours')
  @ApiQuery({ name: 'address', type: 'string', required: false })
  @ApiOperation({
    operationId: 'getPast24HoursAnalytics',
  })
  async getPast24HoursAnalytics(
    @Query('address', OptionalAeAccountAddressPipe)
    address: string | undefined,
  ) {
    const startDate = moment().subtract(24, 'hours').toDate();
    const endDate = moment().toDate();
    const analyticsData =
      await this.cacheDailyAnalyticsDataService.getDateAnalytics(
        startDate,
        endDate,
        address,
      );
    return analyticsData;
  }

  @Get('preview')
  @Render('analytics')
  root() {
    return { message: 'Hello world!' };
  }
}

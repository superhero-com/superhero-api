import { Controller, Get, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { Analytic } from '../entities/analytic.entity';
import { ApiQuery } from '@nestjs/swagger';
import moment from 'moment';
import { CacheDailyAnalyticsDataService } from '../services/cache-daily-analytics-data.service';

@Controller('analytics')
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
  async getAnalyticsData(
    @Query('start_date') start_date: string,
    @Query('end_date') end_date: string,
    @Query('force_pull') force_pull: boolean,
  ) {
    const startDate = moment(
      start_date ?? moment().subtract(10, 'day').format('YYYY-MM-DD'),
    ).toDate();
    const endDate = moment(
      end_date ?? moment().add(1, 'day').format('YYYY-MM-DD'),
    ).toDate();

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
}

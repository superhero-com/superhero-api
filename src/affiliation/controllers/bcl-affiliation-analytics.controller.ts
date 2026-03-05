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
import { BclAffiliationAnalyticsService } from '../services/bcl-affiliation-analytics.service';

@Controller('bcl-affiliation/analytics')
@ApiTags('BCL-Affiliation')
export class BclAffiliationAnalyticsController {
  constructor(
    private readonly bclAffiliationAnalyticsService: BclAffiliationAnalyticsService,
  ) {}

  @Get('')
  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiQuery({ name: 'end_date', type: 'string', required: false })
  @ApiOperation({ operationId: 'getBclAffiliationAnalytics' })
  async getAnalytics(
    @Query('start_date') start_date?: string,
    @Query('end_date') end_date?: string,
  ) {
    // Basic validation to avoid surprising huge queries from malformed inputs.
    if (start_date && !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) {
      throw new BadRequestException('start_date must be YYYY-MM-DD');
    }
    if (end_date && !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
      throw new BadRequestException('end_date must be YYYY-MM-DD');
    }

    return this.bclAffiliationAnalyticsService.getDashboardData({
      start_date,
      end_date,
    });
  }

  @Get('top-inviters')
  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiQuery({ name: 'end_date', type: 'string', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiOperation({ operationId: 'getBclAffiliationTopInviters' })
  async topInviters(
    @Query('start_date') start_date?: string,
    @Query('end_date') end_date?: string,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit = 10,
  ) {
    return this.bclAffiliationAnalyticsService.getTopInviters({
      start_date,
      end_date,
      limit,
    });
  }

  @Get('preview')
  @Render('bcl-affiliation-analytics')
  @ApiOperation({ operationId: 'previewBclAffiliationAnalytics' })
  preview() {
    return { message: 'Hello world!' };
  }
}

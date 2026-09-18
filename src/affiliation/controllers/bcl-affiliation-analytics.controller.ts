import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
  Render,
  UseGuards,
} from '@nestjs/common';
import { ApiBasicAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AffiliationAnalyticsGuard } from '../guards/affiliation-analytics.guard';
import { BclAffiliationAnalyticsService } from '../services/bcl-affiliation-analytics.service';

// Internal operator dashboards. Every route here joins a wallet address to an
// X handle, a follower count and a payout — deanonymising data that has no
// business being served to the open internet, so the key is enforced for the
// whole controller rather than route by route (a new route must not be able to
// arrive unguarded by omission).
@Controller('bcl-affiliation/analytics')
@ApiTags('BCL-Affiliation')
@ApiBasicAuth('affiliation-analytics')
@UseGuards(AffiliationAnalyticsGuard)
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

  @Get('x-verification')
  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiQuery({ name: 'end_date', type: 'string', required: false })
  @ApiOperation({ operationId: 'getBclAffiliationXVerificationAnalytics' })
  async getXVerificationAnalytics(
    @Query('start_date') start_date?: string,
    @Query('end_date') end_date?: string,
  ) {
    if (start_date && !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) {
      throw new BadRequestException('start_date must be YYYY-MM-DD');
    }
    if (end_date && !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
      throw new BadRequestException('end_date must be YYYY-MM-DD');
    }

    return this.bclAffiliationAnalyticsService.getXVerificationData({
      start_date,
      end_date,
    });
  }

  @Get('x-invite')
  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiQuery({ name: 'end_date', type: 'string', required: false })
  @ApiOperation({ operationId: 'getBclAffiliationXInviteUsageAnalytics' })
  async getXInviteUsageAnalytics(
    @Query('start_date') start_date?: string,
    @Query('end_date') end_date?: string,
  ) {
    if (start_date && !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) {
      throw new BadRequestException('start_date must be YYYY-MM-DD');
    }
    if (end_date && !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
      throw new BadRequestException('end_date must be YYYY-MM-DD');
    }

    return this.bclAffiliationAnalyticsService.getXInviteUsageData({
      start_date,
      end_date,
    });
  }

  @Get('x-onboarding')
  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiQuery({ name: 'end_date', type: 'string', required: false })
  @ApiOperation({ operationId: 'getBclAffiliationXOnboardingAnalytics' })
  async getXOnboardingAnalytics(
    @Query('start_date') start_date?: string,
    @Query('end_date') end_date?: string,
  ) {
    if (start_date && !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) {
      throw new BadRequestException('start_date must be YYYY-MM-DD');
    }
    if (end_date && !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
      throw new BadRequestException('end_date must be YYYY-MM-DD');
    }

    return this.bclAffiliationAnalyticsService.getXOnboardingData({
      start_date,
      end_date,
    });
  }

  @Get('preview')
  @Render('bcl-affiliation-analytics')
  @ApiOperation({ operationId: 'previewBclAffiliationAnalytics' })
  preview() {
    return { message: 'Hello world!' };
  }

  @Get('x-verification/preview')
  @Render('bcl-affiliation-x-verification')
  @ApiOperation({ operationId: 'previewBclAffiliationXVerificationAnalytics' })
  xVerificationPreview() {
    return { message: 'Hello world!' };
  }

  @Get('x-invite/preview')
  @Render('bcl-affiliation-x-invite')
  @ApiOperation({ operationId: 'previewBclAffiliationXInviteAnalytics' })
  xInvitePreview() {
    return { message: 'Hello world!' };
  }

  @Get('x-onboarding/preview')
  @Render('bcl-affiliation-x-onboarding')
  @ApiOperation({ operationId: 'previewBclAffiliationXOnboardingAnalytics' })
  xOnboardingPreview() {
    return { message: 'Hello world!' };
  }

  @Get('x-explorer')
  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiQuery({ name: 'end_date', type: 'string', required: false })
  @ApiOperation({
    operationId: 'getBclAffiliationXExplorer',
    summary:
      "Per-wallet X verification detail, including each wallet's invite subtree",
  })
  async getXExplorer(
    @Query('start_date') start_date?: string,
    @Query('end_date') end_date?: string,
  ) {
    if (start_date && !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) {
      throw new BadRequestException('start_date must be YYYY-MM-DD');
    }
    if (end_date && !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
      throw new BadRequestException('end_date must be YYYY-MM-DD');
    }
    return this.bclAffiliationAnalyticsService.getXExplorerData({
      start_date,
      end_date,
    });
  }

  @Get('x-explorer/preview')
  @Render('bcl-affiliation-x-explorer')
  @ApiOperation({ operationId: 'previewBclAffiliationXExplorer' })
  xExplorerPreview() {
    return { message: 'Hello world!' };
  }
}

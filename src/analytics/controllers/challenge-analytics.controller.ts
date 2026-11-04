import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Render,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import moment from 'moment';
import { ChallengeAnalyticsService } from '../services/challenge-analytics.service';
import { isAeAccountAddress } from '@/common/validation/request-validation';

const MAX_ADDRESSES = 10;
const MAX_RANGE_DAYS = 366;

@Controller('analytics')
@ApiTags('Analytics')
export class ChallengeAnalyticsController {
  constructor(
    private readonly challengeAnalyticsService: ChallengeAnalyticsService,
  ) {}

  @Get('challenge')
  @ApiQuery({
    name: 'addresses',
    type: 'string',
    required: true,
    description: `Comma-separated list of account addresses (max ${MAX_ADDRESSES})`,
  })
  @ApiQuery({
    name: 'start_date',
    type: 'string',
    required: false,
    description: 'First day (YYYY-MM-DD), default 14 days ago',
  })
  @ApiQuery({
    name: 'end_date',
    type: 'string',
    required: false,
    description: `Last day (YYYY-MM-DD), default today; the range covers at most ${MAX_RANGE_DAYS} days`,
  })
  @ApiOperation({
    operationId: 'getChallengeAnalytics',
  })
  async getChallengeAnalytics(
    @Query('addresses') addressesRaw: string,
    @Query('start_date') start_date: string,
    @Query('end_date') end_date: string,
  ) {
    const addresses = (addressesRaw ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a.length > 0);

    if (addresses.length === 0) {
      throw new BadRequestException(
        'At least one address is required (addresses=ak_a,ak_b,...)',
      );
    }

    if (addresses.length > MAX_ADDRESSES) {
      throw new BadRequestException(
        `Too many addresses: max ${MAX_ADDRESSES} per request (got ${addresses.length})`,
      );
    }

    const invalid = addresses.filter((a) => !isAeAccountAddress(a));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Invalid account address(es): ${invalid.join(', ')}`,
      );
    }

    // Deduplicate while preserving the user-provided order.
    const uniqueAddresses = Array.from(new Set(addresses));

    const startDate = moment(
      start_date ?? moment().subtract(14, 'day').format('YYYY-MM-DD'),
    );
    const endDate = moment(end_date ?? moment().format('YYYY-MM-DD'));

    if (!startDate.isValid() || !endDate.isValid()) {
      throw new BadRequestException(
        'start_date and end_date must be valid dates',
      );
    }

    if (startDate.isAfter(endDate)) {
      throw new BadRequestException('Start date must be before end date');
    }

    // The response holds one row per address per day, built in memory.
    const days =
      moment(endDate)
        .startOf('day')
        .diff(moment(startDate).startOf('day'), 'days') + 1;
    if (days > MAX_RANGE_DAYS) {
      throw new BadRequestException(
        `Date range must be at most ${MAX_RANGE_DAYS} days (got ${days})`,
      );
    }

    const rows = await this.challengeAnalyticsService.getChallengeAnalytics(
      uniqueAddresses,
      startDate.toDate(),
      endDate.toDate(),
    );

    return rows;
  }

  @Get('challenge/preview')
  @Render('challenge-analytics')
  preview() {
    return {};
  }
}

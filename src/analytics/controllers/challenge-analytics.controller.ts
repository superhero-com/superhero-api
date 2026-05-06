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
  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiQuery({ name: 'end_date', type: 'string', required: false })
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
    ).toDate();
    const endDate = moment(end_date ?? moment().format('YYYY-MM-DD')).toDate();

    if (startDate > endDate) {
      throw new BadRequestException('Start date must be before end date');
    }

    const rows = await this.challengeAnalyticsService.getChallengeAnalytics(
      uniqueAddresses,
      startDate,
      endDate,
    );

    return rows;
  }

  @Get('challenge/preview')
  @Render('challenge-analytics')
  preview() {
    return {};
  }
}

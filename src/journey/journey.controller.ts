import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Render,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiExcludeEndpoint,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { AffiliationAnalyticsGuard } from '@/affiliation/guards/affiliation-analytics.guard';
import { JourneyIngestBuffer } from './journey-ingest.buffer';
import { parseJourneyPayload } from './journey-payload';
import {
  findJourneyFunnel,
  JourneyQueryService,
  listJourneyFunnels,
} from './journey-query.service';
import { resolveJourneyRange } from './journey-range';
import { DEFAULT_JOURNEY_FUNNEL_ID } from './journey.constants';

/**
 * Public, anonymous ingest for the web app's journey events.
 *
 * Always 204 with an empty body, whatever arrives: malformed input is dropped
 * silently, and the handler only queues rows in memory, so it never waits on
 * the database. It reads nothing but the body: no cookies, IP, UA string or
 * referrer. The raw body is read by `journeyIngestBodyHandlers` (see main.ts).
 */
@Controller('analytics/journey')
@ApiTags('Analytics')
export class JourneyIngestController {
  constructor(private readonly buffer: JourneyIngestBuffer) {}

  @Post('events')
  @HttpCode(204)
  @ApiOperation({
    operationId: 'ingestJourneyEvents',
    summary:
      'Anonymous journey events: {"v":1,"a":"<uuid>","e":[{"n","p","t"}]}. Always 204.',
  })
  ingest(@Req() request: Request): void {
    try {
      this.buffer.push(parseJourneyPayload(request.body));
    } catch {
      // Never surface anything to the client.
    }
  }
}

function checkFunnel(id?: string) {
  const funnel = findJourneyFunnel(id);
  if (!funnel) {
    throw new BadRequestException(
      `funnel must be one of: ${listJourneyFunnels()
        .map((f) => f.id)
        .join(', ')}`,
    );
  }
  return funnel;
}

/**
 * Operator dashboard over the journey events. A separate class from the
 * public ingest on purpose: the login is enforced for the whole controller, so
 * a route added here later cannot arrive unguarded by omission.
 */
@Controller('analytics/journey')
@ApiTags('Analytics')
@UseGuards(AffiliationAnalyticsGuard)
export class JourneyDashboardController {
  constructor(private readonly queries: JourneyQueryService) {}

  @Get('funnel')
  @ApiQuery({ name: 'funnel', type: 'string', required: false })
  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiQuery({ name: 'end_date', type: 'string', required: false })
  @ApiOperation({ operationId: 'getJourneyFunnel' })
  async funnel(
    @Query('funnel') funnelId?: string,
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
  ) {
    const funnel = checkFunnel(funnelId || DEFAULT_JOURNEY_FUNNEL_ID);
    const range = resolveJourneyRange(startDate, endDate);
    return this.queries.getFunnel(funnel, range);
  }

  @Get('pages')
  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiQuery({ name: 'end_date', type: 'string', required: false })
  @ApiOperation({ operationId: 'getJourneyPageFlow' })
  async pages(
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
  ) {
    return this.queries.getPageFlow(resolveJourneyRange(startDate, endDate));
  }

  @Get('preview')
  @ApiExcludeEndpoint()
  @Render('user-journey')
  preview() {
    return {
      title: 'User journey',
      active: 'user-journey',
      funnels: JSON.stringify(listJourneyFunnels()),
    };
  }
}

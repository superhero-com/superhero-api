import {
  shortsStorageScope,
  shortsStorageSourceHash,
} from './shorts-runtime-scope';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ShortsAnalyticsService,
  PlaybackEvent,
} from './shorts-analytics.service';
import { ShortsMeasurementsService } from './shorts-measurements.service';
import { ShortsRecordsService } from './shorts-records.service';
import { ShortsScope } from './shorts-metadata.service';

@Injectable()
export class ShortsHostedAnalyticsService
  extends ShortsAnalyticsService
  implements OnModuleDestroy
{
  private readonly logger = new Logger(ShortsHostedAnalyticsService.name);
  since = 0;
  private scope?: ShortsScope;
  private timer?: ReturnType<typeof setInterval>;
  private cleanup?: Promise<void>;
  constructor(
    private readonly measurements: ShortsMeasurementsService,
    private readonly records: ShortsRecordsService,
  ) {
    super();
  }
  async initialize() {
    if (!this.records.shared || !this.records.chain.state.contract)
      throw new ServiceUnavailableException(
        'Hosted analytics require shared content',
      );
    const scope = shortsStorageScope(this.records.chain);
    this.since = await this.measurements.initialize(
      scope,
      shortsStorageSourceHash(this.records.chain),
    );
    this.scope = scope;
  }
  start() {
    this.ready();
    if (this.timer) return;
    this.timer = setInterval(() => this.prune(), 300000);
    this.timer.unref();
    this.prune();
  }
  private ready() {
    if (!this.scope)
      throw new ServiceUnavailableException('Analytics are not initialized');
    shortsStorageScope(this.records.chain);
    return this.scope;
  }
  counters(id: string) {
    return this.measurements.counters(this.ready(), id);
  }
  async record(
    short: { id: string; duration: number },
    event: PlaybackEvent,
    verifiedStart?: number,
  ) {
    const accepted = await this.measurements.record(
      this.ready(),
      short.id,
      event,
      verifiedStart,
    );
    return { accepted, ...(await this.counters(short.id)) };
  }
  forget(session: string) {
    return this.measurements.forget(this.ready(), session);
  }
  report(ids: string[], days: number) {
    return this.measurements.report(this.ready(), ids, days);
  }
  creatorReport(creator: string, days: number, shortId?: string) {
    return this.measurements.creatorReport(
      this.ready(),
      creator,
      days,
      shortId,
    );
  }
  private prune() {
    if (this.cleanup) return;
    this.cleanup = this.measurements
      .prune(this.ready())
      .then(() => undefined)
      .catch(() =>
        this.logger.warn(
          'Analytics cleanup unavailable; retained data remains excluded from reports',
        ),
      )
      .finally(() => {
        this.cleanup = undefined;
      });
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.cleanup;
  }
}

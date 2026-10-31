import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { JOURNEY_LIMITS } from './journey.constants';

/** Deletes journey events older than the retention window, once a day. */
@Injectable()
export class JourneyRetentionService {
  private readonly logger = new Logger(JourneyRetentionService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'journey-events-retention' })
  async purgeExpired(): Promise<void> {
    try {
      await this.dataSource.query(
        `DELETE FROM journey_events WHERE occurred_at < now() - make_interval(days => $1)`,
        [JOURNEY_LIMITS.RETENTION_DAYS],
      );
    } catch (error) {
      this.logger.warn(
        `Journey retention purge failed (code ${(error as { code?: string })?.code ?? 'unknown'})`,
      );
    }
  }
}

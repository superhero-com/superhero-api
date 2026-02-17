import { DATABASE_CONFIG } from '@/configs';
import {
  getStabilizationSnapshot,
  resetStabilizationCounters,
} from '@/utils/stabilization-metrics';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

/**
 * Logs a stabilization checklist for production: timeouts count, queue duration, DB pool config.
 * Grep for [StabilizationChecklist] in logs to confirm stabilization.
 */
@Injectable()
export class StabilizationService {
  private readonly logger = new Logger(StabilizationService.name);

  @Cron('*/5 * * * *') // every 5 minutes
  logStabilizationChecklist(): void {
    const snapshot = getStabilizationSnapshot();
    const extra = (DATABASE_CONFIG as any)?.extra ?? {};
    this.logger.log(
      `[StabilizationChecklist] fetch_timeout_count=${snapshot.fetchTimeoutCount} ` +
        `last_sync_token_holders_duration_ms=${snapshot.lastSyncTokenHoldersDurationMs ?? 'n/a'} ` +
        `last_sync_token_holders_at=${snapshot.lastSyncTokenHoldersCompletedAt ?? 'n/a'} ` +
        `db_pool_max=${extra.max ?? 'n/a'} db_pool_min=${extra.min ?? 'n/a'} ` +
        `db_pool_idle_timeout_ms=${extra.idleTimeoutMillis ?? 'n/a'} ` +
        `db_pool_connection_timeout_ms=${extra.connectionTimeoutMillis ?? 'n/a'}`,
    );
    resetStabilizationCounters();
  }
}

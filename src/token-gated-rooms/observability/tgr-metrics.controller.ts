import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RateLimitGuard } from '@/api-core/guards/rate-limit.guard';
import { TgrMetricsService } from './tgr-metrics.service';
import { TGR_SLOS } from './tgr-metrics.constants';
import type { TgrMetricsReport } from './tgr-metrics.collector';

/**
 * Token-gated-rooms observability read surface (Task 15, plan §13).
 *
 * MAIN process. Mounted under the global `api` prefix → `GET /api/tgr/metrics`.
 * Route `tgr/metrics` (the task's alternate to `rooms/metrics`) is deliberately
 * chosen so it can never collide with Task 13's `GET /api/rooms/:saleAddress`
 * param route.
 *
 * Returns the same computed object as the cron `[TgrMetrics] …` line plus an
 * `overallStatus` (healthy/warning/critical from the alert rules), modeled on
 * `MdwController.getHealth()`. Read-only and public (validated by nothing — it
 * exposes no PII, only aggregate counts), rate-limited like the other read APIs.
 *
 * ## Process-local caveat (documented per Req 3)
 * The relay-writer/subscriber flags + the publish rate counters
 * (`publishOk`/`publishFailed`/`ackTimeouts`/reconnects) live in **worker**
 * memory. Served from the main process they read as their main-process values
 * (the relay socket lives only in the worker), so `processLocal:false` flags that
 * the relay/counter fields here are NOT authoritative — the WORKER's
 * `[TgrMetrics]` log line + Bull Board are the source for those. The Postgres
 * gauges (distributions, drift, reconcile age, backfill) are authoritative from
 * either process.
 */
@ApiTags('token-gated-rooms')
@Controller('tgr')
@UseGuards(RateLimitGuard)
export class TgrMetricsController {
  constructor(private readonly metrics: TgrMetricsService) {}

  /**
   * Machine-readable TGR pipeline health/metrics. The `slos` block restates the
   * codified SLO targets (Req 7) so a dashboard can chart the proxy latency
   * against them without hard-coding the thresholds.
   */
  @Get('metrics')
  @ApiOkResponse({
    description:
      'TGR pipeline metrics: queue depth/lag, relay health, relay_state + ' +
      'nostr_room_state distributions, Postgres-vs-relay drift, reconcile ' +
      'staleness, backfill progress, and an overallStatus. The relay/counter ' +
      'fields are worker-local (processLocal=false when served from main).',
  })
  async getMetrics(): Promise<
    TgrMetricsReport & {
      thresholds: ReturnType<TgrMetricsService['getThresholds']>;
      slos: typeof TGR_SLOS;
    }
  > {
    // Served from main → worker-local counters/flags are not authoritative here.
    const report = await this.metrics.collect(false);
    return {
      ...report,
      thresholds: this.metrics.getThresholds(),
      slos: TGR_SLOS,
    };
  }
}

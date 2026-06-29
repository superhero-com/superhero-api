import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Token } from '@/tokens/entities/token.entity';
import tgrConfig from '../config/tgr.config';
import { RoomMembership } from '../entities/room-membership.entity';
import { RoomBackfillState } from '../entities/room-backfill-state.entity';
import { TgrMetricsService } from './tgr-metrics.service';
import { TgrMetricsController } from './tgr-metrics.controller';

/**
 * Observability & SLOs for token-gated rooms (plan §13).
 *
 * Plain self-contained `@Module` (worker mode removed — see `deworker-plan.md`).
 * The collector (`TgrMetricsService`, a `@Cron` emitter) and the HTTP read surface
 * (`TgrMetricsController`, `GET /api/tgr/metrics`) both load in the single process.
 *
 * ## Queues
 * The collector reads depth/lag via `@Optional() @InjectQueue` against the
 * canonical TGR queues. It registers NONE of them (avoids double-registration):
 * `TokenGatedRoomsModule` / `RoomNotificationsModule` already do. Imported by
 * `TokenGatedRoomsModule` AFTER those queue registrations so the tokens resolve.
 *
 * Boot-safe: nothing schedules/enqueues in a lifecycle hook; the only recurring
 * work is the read-only metrics `@Cron`.
 */
@Module({
  imports: [
    ConfigModule.forFeature(tgrConfig),
    TypeOrmModule.forFeature([Token, RoomMembership, RoomBackfillState]),
  ],
  providers: [TgrMetricsService],
  controllers: [TgrMetricsController],
  exports: [TgrMetricsService],
})
export class TgrObservabilityModule {}

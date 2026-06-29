import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { ConfigType } from '@nestjs/config';
import { Token } from '@/tokens/entities/token.entity';
import { CommunityRoom } from '../entities/community-room.entity';
import { RoomStateService } from './room-state.service';
import tgrConfig, { isRelayConfigured } from '../config/tgr.config';
import {
  TGR_BALANCE_CHANGED,
  TGR_COMMUNITY_UPSERTED,
  type TgrBalanceChangedPayload,
} from '../events';

export interface BackfillRunResult {
  processed: number;
  emitted: number;
  failed: number;
}

/**
 * Name of the periodic roomless-token provisioning cron registered on the Nest
 * {@link SchedulerRegistry} (worker-only). Re-derives the `room_id IS NULL`
 * working set every tick → resumable after a crash; idempotent (a token whose
 * `room_id` got stamped by an ACK drops out of the selection).
 */
export const ROOM_PROVISION_SCAN_JOB = 'tgr-room-provision-scan';

/** How often the roomless-token provisioning cron fires (5 minutes). */
export const ROOM_PROVISION_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Resumable per-token backfill of `community_room` desired state (Task 04 req §6).
 *
 * Iterates the existing `Token` registry (the DB directly — never `/api/tokens`)
 * ordered by `community_room.state_synced_at ASC NULLS FIRST`, so never-synced
 * and stalest rooms are processed first. The per-row `state_synced_at` IS the
 * cursor (plan §8): every successful `readAndUpsertRoomState` stamps it `now`, so
 * a re-run naturally resumes where it left off and an interrupted run completes
 * the remainder. Errors are isolated per token (a single failed `get_state` does
 * not abort the batch — log + continue, leaving `state_synced_at` unset so the
 * token is retried on the next pass).
 *
 * NOTE: batch size / throughput are LOAD-TUNED with the eager room backfill
 * (Task 09 owns the 54k load-test); the default here (`backfillBatchSize` ≈ 200)
 * is conservative.
 */
@Injectable()
export class CommunityRoomBackfillService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(CommunityRoomBackfillService.name);

  /** Single-flight guard so overlapping 5-minute ticks never stack. */
  private provisionRunning = false;

  constructor(
    @InjectRepository(Token)
    private readonly tokenRepository: Repository<Token>,
    @InjectRepository(CommunityRoom)
    private readonly communityRoomRepository: Repository<CommunityRoom>,
    private readonly roomStateService: RoomStateService,
    private readonly eventEmitter: EventEmitter2,
    private readonly scheduler: SchedulerRegistry,
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
  ) {}

  /**
   * Schedule the 5-minute roomless-token provisioning cron on the Nest
   * {@link SchedulerRegistry} — relay-gated (worker mode removed, see
   * `deworker-plan.md`). Room creation publishes to the relay, so we only schedule
   * the cron when a relay is configured (`isRelayConfigured`); otherwise this is a
   * no-op. The interval re-derives the `room_id IS NULL` working set every tick →
   * resumable after a crash without losing rows.
   */
  onModuleInit(): void {
    if (!isRelayConfigured(this.config)) {
      return;
    }
    try {
      const interval = setInterval(() => {
        void this.runProvisionSafely();
      }, ROOM_PROVISION_INTERVAL_MS);
      interval.unref?.();
      this.scheduler.addInterval(ROOM_PROVISION_SCAN_JOB, interval);
      this.logger.log(
        `scheduled roomless-token provisioning every ${
          ROOM_PROVISION_INTERVAL_MS / 1000
        }s`,
      );
    } catch (error: any) {
      this.logger.warn(
        `failed to schedule roomless-token provisioning: ${error?.message ?? error}`,
      );
    }
  }

  /** Tear down the interval on shutdown so tests / restarts don't leak timers. */
  onApplicationShutdown(): void {
    try {
      if (this.scheduler.doesExist?.('interval', ROOM_PROVISION_SCAN_JOB)) {
        this.scheduler.deleteInterval(ROOM_PROVISION_SCAN_JOB);
      }
    } catch {
      // best-effort
    }
  }

  /** Run the provisioning scan with single-flight + error isolation (interval cb). */
  private async runProvisionSafely(): Promise<void> {
    if (this.provisionRunning) {
      return;
    }
    this.provisionRunning = true;
    try {
      await this.provisionRoomlessTokens(this.config.roomProvisionBatchSize);
    } catch (error: any) {
      this.logger.error(
        `roomless-token provisioning scan failed: ${error?.message ?? error}`,
      );
    } finally {
      this.provisionRunning = false;
    }
  }

  /**
   * Provision relay rooms for up to `limit` tokens that still have no confirmed
   * room (`room_id IS NULL AND sale_address IS NOT NULL`). For each: read+upsert the
   * on-chain community state (the canonical reactive seed), and if that upsert did
   * NOT itself emit `tgr.community.upserted` (the retry case — the `community_room`
   * row already exists but the relay room / `room_id` is still NULL), FORCE-emit it
   * so the decoupled relay-create (RoomBackfillService) + member-seed
   * (EligibilityService) chains re-fire. Errors are isolated per token (log +
   * continue). Idempotent: once `room_id` is stamped on the `9007` ACK the token
   * drops out of the selection.
   *
   * **Worth-gating + priority:** only tokens with a non-zero `market_cap` AND at
   * least 2 holders get a room — there is no point provisioning a relay group for a
   * worthless / single-holder token. Highest market cap first, so the most valuable
   * communities are provisioned ahead of the long tail.
   *
   * @returns the number of tokens processed.
   */
  async provisionRoomlessTokens(limit: number): Promise<number> {
    const tokens = await this.tokenRepository
      .createQueryBuilder('token')
      .where('token.room_id IS NULL')
      .andWhere('token.sale_address IS NOT NULL')
      .andWhere('token.market_cap > 0')
      .andWhere('token.holders_count >= 2')
      .orderBy('token.market_cap', 'DESC')
      .limit(limit)
      .getMany();

    let processed = 0;
    for (const token of tokens) {
      try {
        const result =
          await this.roomStateService.readAndUpsertRoomState(token);
        // readAndUpsertRoomState emits on first creation; force-emit covers the
        // retry case where community_room already exists but room_id is still NULL.
        if (!result.emitted) {
          this.eventEmitter.emit(TGR_COMMUNITY_UPSERTED, {
            saleAddress: token.sale_address,
          });
        }
        processed += 1;
      } catch (error: any) {
        this.logger.error(
          `[provision] failed to provision room for ${token.sale_address}: ${
            error?.message ?? error
          }`,
        );
        // Leave room_id NULL → retried on the next tick.
      }
    }

    if (processed > 0) {
      this.logger.log(
        `[provision] processed ${processed} roomless token(s) (room_id IS NULL)`,
      );
    }
    return processed;
  }

  /**
   * Buy → create the room immediately if missing (relay-gated).
   *
   * A buy on a roomless token raises `tgr.balance.changed` (Task 03). The payload
   * carries the AEX9 `Token.address` (NOT `sale_address`), so we resolve the token
   * by `address`. If found AND it has no confirmed room yet (`room_id IS NULL`), we
   * provision it right away — read+upsert the community state and force-emit
   * `tgr.community.upserted` when the upsert was a no-op — so the room is created
   * without waiting for the 5-minute cron. The existing eligibility chain then adds
   * the buyer as a member once `community_room` exists. Idempotent: once `room_id`
   * is stamped on the ACK, subsequent balance changes for the token skip. No relay
   * configured → no room to create, so we skip.
   */
  @OnEvent(TGR_BALANCE_CHANGED, { async: true })
  async onBalanceChanged(payload: TgrBalanceChangedPayload): Promise<void> {
    if (!isRelayConfigured(this.config)) {
      return;
    }
    const tokenAddress = payload?.tokenAddress;
    if (!tokenAddress) {
      return;
    }
    try {
      const token = await this.tokenRepository.findOne({
        where: { address: tokenAddress },
      });
      if (!token || !token.sale_address) {
        return;
      }
      // Already has a confirmed room → nothing to do (idempotent fast-path).
      if (token.room_id) {
        return;
      }
      const result = await this.roomStateService.readAndUpsertRoomState(token);
      if (!result.emitted) {
        this.eventEmitter.emit(TGR_COMMUNITY_UPSERTED, {
          saleAddress: token.sale_address,
        });
      }
    } catch (error: any) {
      this.logger.error(
        `[provision] buy-triggered room create for token ${tokenAddress} failed: ${
          error?.message ?? error
        }`,
      );
    }
  }

  /**
   * Run the backfill to completion. Repeatedly pulls the next batch of stalest /
   * never-synced tokens and upserts each room until none remain unsynced.
   *
   * @param options.batchSize override the configured batch size (tests).
   * @param options.maxBatches safety cap on the number of batches per run; when
   *   omitted the loop runs until a batch yields no progress.
   */
  async run(
    options: {
      batchSize?: number;
      maxBatches?: number;
    } = {},
  ): Promise<BackfillRunResult> {
    const batchSize = options.batchSize ?? this.config.backfillBatchSize;
    const result: BackfillRunResult = { processed: 0, emitted: 0, failed: 0 };

    let batches = 0;
    let lastSynced = new Set<string>();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (options.maxBatches !== undefined && batches >= options.maxBatches) {
        break;
      }

      const tokens = await this.nextBatch(batchSize);
      if (tokens.length === 0) {
        break;
      }

      // Loop-guard: if a whole batch failed (state_synced_at stays unset) the
      // same tokens would be re-selected forever. Track the previous batch's
      // sale_addresses; if we get the exact same set with zero progress, stop.
      const currentSet = new Set(tokens.map((t) => t.sale_address));
      const sameAsLast =
        currentSet.size === lastSynced.size &&
        [...currentSet].every((s) => lastSynced.has(s));

      let progressed = 0;
      for (const token of tokens) {
        try {
          const upsert =
            await this.roomStateService.readAndUpsertRoomState(token);
          result.processed += 1;
          progressed += 1;
          if (upsert.emitted) {
            result.emitted += 1;
          }
        } catch (error: any) {
          result.failed += 1;
          this.logger.error(
            `[backfill] failed to sync room for ${token.sale_address}: ${error?.message ?? error}`,
          );
          // Leave state_synced_at unset → retried on the next pass.
        }
      }

      batches += 1;

      if (sameAsLast && progressed === 0) {
        this.logger.warn(
          `[backfill] no progress on a repeated batch of ${tokens.length}; stopping to avoid a hot loop`,
        );
        break;
      }
      lastSynced = currentSet;
    }

    this.logger.log(
      `[backfill] complete: processed=${result.processed} emitted=${result.emitted} failed=${result.failed} (${batches} batches)`,
    );
    return result;
  }

  /**
   * Pull the next batch of tokens, stalest-first. `Token LEFT JOIN community_room`
   * ordered by `community_room.state_synced_at ASC NULLS FIRST` so never-synced
   * rooms come first, then the oldest.
   */
  private async nextBatch(batchSize: number): Promise<Token[]> {
    return (
      this.tokenRepository
        .createQueryBuilder('token')
        .leftJoin(
          CommunityRoom,
          'room',
          'room.sale_address = token.sale_address',
        )
        .where('token.sale_address IS NOT NULL')
        // Only ever-unsynced rows are candidates: once stamped this run, a row drops
        // out of the selection, giving natural resumability + a finite loop.
        .andWhere('room.state_synced_at IS NULL')
        .orderBy('room.state_synced_at', 'ASC', 'NULLS FIRST')
        .addOrderBy('token.created_at', 'ASC')
        // `limit` (raw LIMIT) not `take`: ordering by a non-selected JOINed column
        // breaks TypeORM's distinct-id pagination wrapper. Safe here — the join is
        // to-one (community_room PK = token.sale_address), so no row fan-out.
        .limit(batchSize)
        .getMany()
    );
  }

  /**
   * Count tokens still awaiting an initial sync — useful for observability/tests.
   */
  async pendingCount(): Promise<number> {
    return this.tokenRepository
      .createQueryBuilder('token')
      .leftJoin(CommunityRoom, 'room', 'room.sale_address = token.sale_address')
      .where('token.sale_address IS NOT NULL')
      .andWhere('room.state_synced_at IS NULL')
      .getCount();
  }
}

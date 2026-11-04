import {
  BadRequestException,
  ConflictException,
  Injectable,
  Inject,
  Optional,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ShortsService } from './shorts.service';
import {
  ShortsBackfillBatchesService,
  BackfillItem,
  BackfillPhase,
} from './shorts-backfill-batches.service';
import {
  BackfillBudget,
  BackfillPlan,
  backfillCost,
  backfillFingerprint,
  backfillHash,
  backfillRequest,
} from './shorts-backfill-plan';
import { shortsStorageScope } from './shorts-runtime-scope';
import { shortsDeliverySource } from './shorts-delivery-source';
import { ShortsDeliverySelectionService } from './shorts-delivery-selection.service';
import { ShortsOriginalRestagingService } from './shorts-original-restaging.service';
import { ShortsDeliveryPreparationService } from './shorts-delivery-preparation.service';
import { ShortsDeliveryActivationService } from './shorts-delivery-activation.service';
import { shortsPlaybackDescriptor } from './shorts-playback-descriptor';
import { sourceKey } from './hls-protocol/hls-package';

export const SHORTS_BACKFILL_AUTOMATIC = Symbol('SHORTS_BACKFILL_AUTOMATIC');

/** Trusted, opt-in operations job. Runs one bounded stage per poll. */
@Injectable()
export class ShortsBackfillService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly enabled: boolean;
  private readonly shutdown = new AbortController();
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private active?: Promise<unknown>;
  constructor(
    private readonly shorts: ShortsService,
    private readonly batches: ShortsBackfillBatchesService,
    private readonly selections: ShortsDeliverySelectionService,
    private readonly restaging: ShortsOriginalRestagingService,
    private readonly preparation: ShortsDeliveryPreparationService,
    private readonly activation: ShortsDeliveryActivationService,
    @Optional()
    @Inject(SHORTS_BACKFILL_AUTOMATIC)
    private readonly automatic = true,
  ) {
    const flag = process.env.SHORTS_BACKFILL_ENABLED ?? 'false';
    if (!['true', 'false'].includes(flag))
      throw new Error('Invalid backfill flag');
    this.enabled = flag === 'true';
  }
  private scope() {
    return shortsStorageScope(this.shorts.chain);
  }
  async dryRun(ids: string[], budget: BackfillBudget): Promise<BackfillPlan> {
    const request = backfillRequest(ids, budget),
      scope = this.scope();
    const items: BackfillPlan['items'] = [],
      skipped: BackfillPlan['skipped'] = [];
    for (const id of request.ids) {
      let short;
      try {
        short = await this.shorts.ensurePlayable(id);
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
        skipped.push({ id, reason: 'not_available' });
        continue;
      }
      if (short.original) {
        skipped.push({ id, reason: 'already_original' });
        continue;
      }
      if (await this.batches.held(scope, id)) {
        skipped.push({ id, reason: 'retention_hold' });
        continue;
      }
      let source: ReturnType<typeof shortsDeliverySource>;
      try {
        source = shortsDeliverySource(short);
      } catch {
        skipped.push({ id, reason: 'no_verified_source' });
        continue;
      }
      const expected = await this.selections.state(scope, short);
      if (
        expected.sourceKey !== sourceKey(shortsPlaybackDescriptor(short, scope))
      ) {
        skipped.push({ id, reason: 'already_upgraded' });
        continue;
      }
      items.push({
        id,
        fingerprint: backfillFingerprint(short),
        expected,
        sourceBytes: source.bytes,
      });
    }
    const plan = {
      version: 1 as const,
      items,
      skipped,
      cost: backfillCost(items, request.budget.replicas),
    };
    return { ...plan, hash: backfillHash({ request, plan }) };
  }
  async start(
    id: string,
    ids: string[],
    budget: BackfillBudget,
    planHash: string,
  ) {
    const request = { ...backfillRequest(ids, budget), planHash };
    if (typeof planHash !== 'string' || !/^[a-f0-9]{64}$/.test(planHash))
      throw new BadRequestException('A reviewed dry run is required');
    try {
      return this.batches.match(
        await this.batches.get(this.scope(), id),
        request,
      );
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
    }
    this.assertEnabled();
    const plan = await this.dryRun(ids, budget);
    if (!plan.items.length || plan.hash !== planHash)
      throw new ConflictException(
        'Backfill dry run changed or has no eligible posts',
      );
    if (
      plan.cost.additionalLogicalBytes > budget.maxAdditionalLogicalBytes ||
      plan.cost.encodingSeconds > budget.maxEncodingSeconds
    )
      throw new ConflictException('Backfill exceeds the accepted budget');
    return this.batches.create(this.scope(), id, request, plan);
  }
  cancel(id: string) {
    return this.batches.cancel(this.scope(), id);
  }
  status(id: string) {
    return this.batches.get(this.scope(), id);
  }
  private assertEnabled() {
    if (
      !this.enabled ||
      this.shutdown.signal.aborted ||
      process.env.SHORTS_LEGACY_BACKFILL_ENABLED !== 'true' ||
      process.env.SHORTS_LEGACY_PLAYBACK_ENABLED !== 'true' ||
      process.env.SHORTS_DELIVERY_SELECTION_ENABLED !== 'true'
    )
      throw new ServiceUnavailableException('Backfill is disabled');
  }
  async advance(id: string, parent?: AbortSignal) {
    this.assertEnabled();
    if (this.active) return this.status(id);
    const work = this.run(id, parent);
    this.active = work;
    try {
      return await work;
    } finally {
      this.active = undefined;
    }
  }
  private async run(id: string, parent?: AbortSignal) {
    const scope = this.scope(),
      token = await this.batches.claim(scope, id);
    if (!token) return this.status(id);
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      this.shutdown.signal,
      AbortSignal.timeout(300000),
      ...(parent ? [parent] : []),
    ]);
    let checking: Promise<void> | undefined;
    const check = async () => {
      signal.throwIfAborted();
      if (!(await this.batches.owned(scope, id, token)))
        throw new ConflictException('Backfill claim changed');
      signal.throwIfAborted();
    };
    const timer = setInterval(() => {
      if (!checking && !signal.aborted)
        checking = check()
          .catch(() => {
            controller.abort();
          })
          .finally(() => {
            checking = undefined;
          });
    }, 1000);
    timer.unref();
    let item: BackfillItem | undefined;
    try {
      const batch = await this.status(id);
      item = batch.items.find((i) =>
        ['planned', 'preparing', 'ready'].includes(i.phase),
      );
      await check();
      if (!item) {
        await this.batches.finish(scope, id, token);
        return this.status(id);
      }
      // Recover a successful activation whose acknowledgement was lost before
      // doing a new policy check or making another state change.
      const saved = await this.selections.operation(
        scope,
        item.short_id,
        item.operation_id,
      );
      if (saved) {
        this.selections.match(
          saved,
          item.plan.expected,
          item.source_key!,
          'activate',
        );
        await this.batches.finish(scope, id, token, item, {
          phase: 'activated',
        });
        return this.status(id);
      }
      const recheck = async () => {
        await check();
        const short = await this.shorts.ensurePlayable(item!.short_id);
        if (
          backfillFingerprint(short) !== item!.plan.fingerprint ||
          (await this.batches.held(scope, item!.short_id))
        )
          throw new ConflictException('Backfill eligibility changed');
        const selected = await this.selections.state(scope, short);
        if (
          selected.sourceKey !== item!.plan.expected.sourceKey ||
          selected.revision !== item!.plan.expected.revision
        )
          throw new ConflictException('Backfill delivery changed');
        await check();
      };
      await recheck();
      if (batch.expired) {
        await this.batches.finish(scope, id, token, item, { phase: 'failed' });
        return this.status(id);
      }
      // Do not admit another background stage while new uploads need capacity.
      if (await this.batches.foreground(scope)) {
        await this.batches.finish(scope, id, token);
        return this.status(id);
      }
      let phase: BackfillPhase = item.phase,
        key: string | undefined;
      if (phase === 'planned') {
        await this.restaging.restage(scope, item.short_id, item.job_id, signal);
        await recheck();
        phase = 'preparing';
      } else if (phase === 'preparing') {
        const job = await this.batches.job(scope, item.job_id);
        if (!job || ['failed', 'cancelled'].includes(job.status))
          phase = 'failed';
        else if (job.status === 'ready') {
          const prepared = await this.preparation.prepare(
            item.short_id,
            item.job_id,
            signal,
            recheck,
          );
          await recheck();
          if (prepared.status === 'ready') {
            phase = 'ready';
            key = prepared.sourceKey;
          }
        }
      } else if (phase === 'ready') {
        await recheck();
        await this.activation.select(
          item.short_id,
          item.source_key!,
          item.plan.expected,
          item.operation_id,
          'activate',
          signal,
        );
        await check();
        phase = 'activated';
      }
      await this.batches.finish(scope, id, token, item, {
        phase,
        sourceKey: key,
      });
    } catch (error) {
      // A cancelled batch is terminal. A stale owner cannot change a successor's
      // checkpoint. Uncertain successful writes are recovered on the next pass.
      if (await this.batches.owned(scope, id, token)) {
        const saved =
          item?.source_key &&
          (await this.selections.operation(
            scope,
            item.short_id,
            item.operation_id,
          ));
        if (saved) {
          this.selections.match(
            saved,
            item.plan.expected,
            item.source_key!,
            'activate',
          );
          await this.batches.finish(scope, id, token, item, {
            phase: 'activated',
          });
          return this.status(id);
        }
        await this.batches.finish(
          scope,
          id,
          token,
          item,
          item
            ? {
                phase: item.phase,
                failed: !this.shutdown.signal.aborted && !parent?.aborted,
              }
            : undefined,
        );
      }
      if (this.shutdown.signal.aborted || parent?.aborted) throw error;
    } finally {
      clearInterval(timer);
      controller.abort();
      await checking;
    }
    return this.status(id);
  }
  onApplicationBootstrap() {
    if (!this.enabled || !this.automatic) return;
    this.timer = setInterval(() => {
      if (this.polling || this.shutdown.signal.aborted) return;
      this.polling = (async () => {
        const id = await this.batches.active(this.scope());
        if (id) await this.advance(id);
      })()
        .catch(() => {
          /* Durable state is retried on the next bounded poll. */
        })
        .finally(() => {
          this.polling = undefined;
        });
    }, 10000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    clearInterval(this.timer);
    this.shutdown.abort();
    await Promise.allSettled([this.polling, this.active]);
  }
}

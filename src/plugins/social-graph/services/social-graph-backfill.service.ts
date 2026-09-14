import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { SyncDirectionEnum } from '@/mdw-sync/types/sync-direction';
import { ACTIVE_NETWORK } from '@/configs/network';
import {
  fetchJson,
  resolveMiddlewareNextUrl,
  resolveMiddlewareNextUrlSafely,
  sanitizeJsonForPostgres,
} from '@/utils/common';
import { ITransaction } from '@/utils/types';
import { SocialGraphPlugin } from '../social-graph.plugin';
import { SocialGraphBackfillState } from '../entities/social-graph-backfill-state.entity';
import {
  SOCIAL_GRAPH_CONTRACT_ADDRESS,
  SOCIAL_GRAPH_ENABLED,
} from '../social-graph.constants';

/**
 * One-shot recovery: re-decodes the contract's calls from the middleware so a
 * follow stored before the decode fix (in `txs` but decoded to zero events) or
 * never stored gets its edge. A persisted watermark (`social_graph_backfill_state`)
 * records the highest block already recovered, so the walk — newest-first —
 * stops as soon as it reaches it: the first boot recovers, later boots do not
 * replay the already-recovered history. Idempotent regardless (edges ON CONFLICT
 * DO NOTHING, counts recomputed).
 */
@Injectable()
export class SocialGraphBackfillService implements OnModuleInit {
  private readonly logger = new Logger(SocialGraphBackfillService.name);

  // Cap the walk so a contract with an unexpectedly large call history can
  // never turn boot into an unbounded middleware crawl. 100 txs/page.
  private static readonly PAGE_SAFETY = 50;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Tx)
    private readonly txRepository: Repository<Tx>,
    @InjectRepository(SocialGraphBackfillState)
    private readonly stateRepository: Repository<SocialGraphBackfillState>,
    private readonly plugin: SocialGraphPlugin,
  ) {}

  onModuleInit(): void {
    if (!SOCIAL_GRAPH_ENABLED) {
      return;
    }
    // Detached and best-effort: boot must not block on the middleware, and a
    // backfill failure must not stop the app from starting.
    void this.backfill().catch((error) => {
      this.logger.error(
        'social-graph backfill failed',
        error instanceof Error ? error.stack : String(error),
      );
    });
  }

  /**
   * Walk the contract's calls newest-first, stopping at the persisted watermark,
   * and hand every not-yet-recovered tx to the plugin (saving any never
   * persisted, refreshing `raw` on a stored row that lost its log). A tx stored
   * before the decode fix is in `txs` with zero edges, so it must be reprocessed
   * — but only until the watermark, so a boot after recovery does not replay the
   * whole history. Idempotent, so re-decoding a stored tx is safe.
   *
   * A call history larger than the page-safety window cannot be walked in one
   * boot: the walk reaches only the newest ~5,000 calls before it stops. It then
   * leaves the watermark unadvanced and records `resume_from_height` /
   * `pendingHigh`, so the next boot resumes the walk below where it stopped
   * (scope-bounded to older generations) instead of restarting at the newest page
   * and truncating at the same point. Once the walk finally completes, the
   * highest block seen across the whole effort becomes the watermark.
   */
  async backfill(): Promise<{ saved: number; reprocessed: number }> {
    const middlewareUrl = this.getMiddlewareUrl();
    const { watermark, resumeFrom, pendingHigh } = await this.loadState();

    // Resume below where a prior boot's page-safety stop left off (older
    // generations only) instead of restarting from the newest page; otherwise
    // walk newest-first from the top so we can stop the moment we reach an
    // already-recovered call.
    const startPath =
      resumeFrom != null
        ? `/v3/transactions?type=contract_call&contract=${SOCIAL_GRAPH_CONTRACT_ADDRESS}` +
          `&scope=gen:${resumeFrom}-0&limit=100`
        : `/v3/transactions?type=contract_call&contract=${SOCIAL_GRAPH_CONTRACT_ADDRESS}` +
          `&direction=backward&limit=100`;
    let nextUrl: string | null = resolveMiddlewareNextUrl(
      startPath,
      middlewareUrl,
    );

    let saved = 0;
    let reprocessed = 0;
    let safety = 0;
    let maxHeight = -1;
    // Lowest block height reached this run; where the next boot resumes if the
    // walk truncates before completing.
    let minHeight = Number.POSITIVE_INFINITY;
    // Lowest block height whose replay threw. The watermark must never cross it,
    // or the failed tx stops being re-walked and is lost — the same trap the
    // main indexer avoids by parking failures for retry.
    let minFailedHeight = Number.POSITIVE_INFINITY;
    // Highest block height whose replay threw. On a truncated run the walk must
    // resume above it so every failed call is retried, not skipped past.
    let maxFailedHeight = -1;
    let reachedWatermark = false;

    while (
      nextUrl &&
      !reachedWatermark &&
      safety < SocialGraphBackfillService.PAGE_SAFETY
    ) {
      safety += 1;
      const response = await fetchJson<any>(nextUrl);
      const page: any[] = response?.data ?? [];

      const rows: any[] = [];
      for (const raw of page) {
        if (!raw?.hash || raw?.tx?.type !== 'ContractCallTx') {
          continue;
        }
        const height =
          typeof raw.block_height === 'number' ? raw.block_height : undefined;
        // Newest-first: once we hit a call at/below the watermark, everything
        // after it is already recovered, so stop.
        if (watermark != null && height != null && height <= watermark) {
          reachedWatermark = true;
          break;
        }
        rows.push(raw);
        if (height != null) {
          if (height > maxHeight) {
            maxHeight = height;
          }
          if (height < minHeight) {
            minHeight = height;
          }
        }
      }

      if (rows.length > 0) {
        // One query per page, not one findOne per tx.
        const stored = await this.txRepository.find({
          where: { hash: In(rows.map((raw) => raw.hash as string)) },
        });
        const storedByHash = new Map(stored.map((row) => [row.hash, row]));

        const toSave: Tx[] = [];
        const pageTxs: Tx[] = [];
        for (const raw of rows) {
          const mdwTx = camelcaseKeysDeep(raw) as ITransaction;
          const existing = storedByHash.get(raw.hash as string);
          if (!existing) {
            const entity = this.buildContractCallTxEntity(mdwTx);
            if (!entity) {
              continue;
            }
            toSave.push(entity as Tx);
            pageTxs.push(entity as Tx);
            saved += 1;
          } else {
            // Refresh `raw` from the middleware payload if the stored row lost
            // its log, so the decode below has topics to work with.
            if (!existing.raw?.log && mdwTx.tx) {
              existing.raw = sanitizeJsonForPostgres(mdwTx.tx);
              toSave.push(existing);
            }
            pageTxs.push(existing);
          }
        }

        if (toSave.length > 0) {
          await this.txRepository.save(toSave);
        }
        if (pageTxs.length > 0) {
          const batch = await this.plugin.processBatch(
            pageTxs,
            SyncDirectionEnum.Backward,
          );
          reprocessed += pageTxs.length;
          for (const failure of batch?.failed ?? []) {
            const failedHeight = failure.tx?.block_height;
            if (typeof failedHeight === 'number') {
              if (failedHeight < minFailedHeight) {
                minFailedHeight = failedHeight;
              }
              if (failedHeight > maxFailedHeight) {
                maxFailedHeight = failedHeight;
              }
            }
          }
        }
      }

      if (reachedWatermark) {
        break;
      }
      nextUrl = resolveMiddlewareNextUrlSafely(
        typeof response?.next === 'string' ? response.next : null,
        middlewareUrl,
        this.logger,
        'SocialGraphBackfillService.backfill',
      );
    }

    const truncated =
      !!nextUrl &&
      !reachedWatermark &&
      safety >= SocialGraphBackfillService.PAGE_SAFETY;
    // Highest block recovered across the whole (possibly multi-boot) effort: this
    // run's top, plus the top carried from earlier truncated runs.
    const overallHigh = Math.max(maxHeight, pendingHigh ?? -1, watermark ?? -1);
    // Never let the watermark reach a height whose replay failed: cap it one
    // below the lowest failure so that tx (and any success above it) is
    // re-walked next boot. Re-decoding a recovered tx is idempotent.
    const advanceTo = Math.min(overallHigh, minFailedHeight - 1);

    if (truncated) {
      // Incomplete: never advance the watermark, or a partial run marks
      // unrecovered older calls as done. Instead record where to resume — below
      // the lowest call reached, or above the highest failure so it is retried —
      // and carry the top forward so completion can promote it.
      const resumeNext =
        maxFailedHeight >= 0
          ? maxFailedHeight
          : Number.isFinite(minHeight)
            ? minHeight
            : resumeFrom;
      await this.saveState({
        watermark,
        resumeFrom: resumeNext,
        pendingHigh: overallHigh >= 0 ? overallHigh : pendingHigh,
      });
      this.logger.warn(
        `social-graph backfill hit the page safety limit (${SocialGraphBackfillService.PAGE_SAFETY}); watermark not advanced, resuming below gen ${resumeNext} next boot`,
      );
    } else {
      // Walk complete: promote the carried top to the watermark and clear the
      // in-progress resume state so later boots stop early again.
      const wasInProgress = resumeFrom != null || pendingHigh != null;
      if (advanceTo > (watermark ?? -1) || wasInProgress) {
        await this.saveState({
          watermark: Math.max(advanceTo, watermark ?? -1),
          resumeFrom: null,
          pendingHigh: null,
        });
      }
      if (Number.isFinite(minFailedHeight)) {
        this.logger.warn(
          `social-graph backfill held the watermark at ${advanceTo}; a replay at height ${minFailedHeight} failed and is retried next boot`,
        );
      }
    }

    if (reprocessed > 0) {
      this.logger.log(
        `social-graph backfill complete: saved ${saved}, reprocessed ${reprocessed}, watermark ${Math.max(advanceTo, watermark ?? -1)}`,
      );
    }
    return { saved, reprocessed };
  }

  private async loadState(): Promise<{
    watermark: number | null;
    resumeFrom: number | null;
    pendingHigh: number | null;
  }> {
    const state = await this.stateRepository.findOne({
      where: { contract_address: SOCIAL_GRAPH_CONTRACT_ADDRESS },
    });
    return {
      watermark: state?.last_backfilled_height ?? null,
      resumeFrom: state?.resume_from_height ?? null,
      pendingHigh: state?.pending_high_height ?? null,
    };
  }

  private async saveState(next: {
    watermark: number | null;
    resumeFrom: number | null;
    pendingHigh: number | null;
  }): Promise<void> {
    await this.stateRepository.save({
      contract_address: SOCIAL_GRAPH_CONTRACT_ADDRESS,
      last_backfilled_height: next.watermark,
      resume_from_height: next.resumeFrom,
      pending_high_height: next.pendingHigh,
      updated_at: new Date(),
    });
  }

  private getMiddlewareUrl(): string {
    return (
      this.configService.get<string>('mdw.middlewareUrl') ??
      ACTIVE_NETWORK.middlewareUrl
    );
  }

  /**
   * Shape a middleware contract_call tx exactly like `BlockSyncService`'s own
   * conversion, so a backfilled row is indistinguishable from one the main
   * indexer would have written. `raw` keeps the tx object (including its `log`),
   * which is what the plugin decodes edges from.
   */
  private buildContractCallTxEntity(mdwTx: ITransaction): Partial<Tx> | null {
    if (!mdwTx?.hash || mdwTx.tx?.type !== 'ContractCallTx') {
      return null;
    }
    return {
      hash: mdwTx.hash,
      block_height: mdwTx.blockHeight,
      block_hash: mdwTx.blockHash?.toString() || '',
      micro_index: mdwTx.microIndex?.toString() || '0',
      micro_time: mdwTx.microTime?.toString() || '0',
      signatures: mdwTx.signatures
        ? sanitizeJsonForPostgres(mdwTx.signatures)
        : [],
      encoded_tx: mdwTx.encodedTx || '',
      type: mdwTx.tx?.type || '',
      contract_id: mdwTx.tx?.contractId,
      function: mdwTx.tx?.function,
      caller_id: mdwTx.tx?.callerId,
      sender_id: mdwTx.tx?.senderId,
      recipient_id: mdwTx.tx?.recipientId,
      payload: '',
      raw: mdwTx.tx ? sanitizeJsonForPostgres(mdwTx.tx) : null,
      version: 1,
      created_at: new Date(mdwTx.microTime),
    };
  }
}

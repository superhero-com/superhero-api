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
   */
  async backfill(): Promise<{ saved: number; reprocessed: number }> {
    const middlewareUrl = this.getMiddlewareUrl();
    const watermark = await this.loadWatermark();

    // Newest-first so we can stop the moment we reach an already-recovered call.
    let nextUrl: string | null = resolveMiddlewareNextUrl(
      `/v3/transactions?type=contract_call&contract=${SOCIAL_GRAPH_CONTRACT_ADDRESS}` +
        `&direction=backward&limit=100`,
      middlewareUrl,
    );

    let saved = 0;
    let reprocessed = 0;
    let safety = 0;
    let maxHeight = -1;
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
        if (height != null && height > maxHeight) {
          maxHeight = height;
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
          await this.plugin.processBatch(pageTxs, SyncDirectionEnum.Backward);
          reprocessed += pageTxs.length;
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
    if (truncated) {
      this.logger.warn(
        `social-graph backfill hit the page safety limit (${SocialGraphBackfillService.PAGE_SAFETY}); watermark not advanced, remaining pages retried next boot`,
      );
    } else if (maxHeight > (watermark ?? -1)) {
      // Only advance once the walk finished (not truncated), so a partial run
      // never marks unrecovered older calls as done.
      await this.saveWatermark(maxHeight);
    }

    if (reprocessed > 0) {
      this.logger.log(
        `social-graph backfill complete: saved ${saved}, reprocessed ${reprocessed}, watermark ${Math.max(maxHeight, watermark ?? -1)}`,
      );
    }
    return { saved, reprocessed };
  }

  private async loadWatermark(): Promise<number | null> {
    const state = await this.stateRepository.findOne({
      where: { contract_address: SOCIAL_GRAPH_CONTRACT_ADDRESS },
    });
    return state?.last_backfilled_height ?? null;
  }

  private async saveWatermark(height: number): Promise<void> {
    await this.stateRepository.save({
      contract_address: SOCIAL_GRAPH_CONTRACT_ADDRESS,
      last_backfilled_height: height,
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

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
import {
  SOCIAL_GRAPH_CONTRACT_ADDRESS,
  SOCIAL_GRAPH_ENABLED,
  SOCIAL_GRAPH_START_HEIGHT,
} from '../social-graph.constants';

/**
 * Replays the configured contract's call transactions from the middleware so a
 * follow/unfollow/block dropped by live sync is recovered without a full
 * re-index. It exists because the two indexing paths do not overlap: backward
 * sync only ever walks DOWN from the tip it started at, so anything created
 * above that tip is seen exclusively by the live indexer — and a tip-region
 * ContractCallTx arrives over the websocket with no decoded `function`, which
 * used to fail the relevance filter and never reach the DB. The predicate no
 * longer gates on `function`, but already-missed txs are gone from the DB and
 * the drift reconcile cannot recover them (it only re-checks addresses that
 * already have an edge). This walk closes that gap.
 *
 * Safe to run on every boot: it skips txs already stored, and every mutation it
 * drives is idempotent (edges ON CONFLICT DO NOTHING, counts recomputed).
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
   * Walk every contract-call tx to the social-graph contract, save the ones the
   * indexer never persisted, and process them through the plugin. Returns the
   * counts so a manual trigger (or a test) can assert what it did.
   */
  async backfill(): Promise<{ saved: number; skipped: number }> {
    const middlewareUrl = this.getMiddlewareUrl();
    let nextUrl: string | null = resolveMiddlewareNextUrl(
      `/v3/transactions?type=contract_call&contract=${SOCIAL_GRAPH_CONTRACT_ADDRESS}` +
        `&scope=gen:${SOCIAL_GRAPH_START_HEIGHT}-999999999&direction=forward&limit=100`,
      middlewareUrl,
    );

    let saved = 0;
    let skipped = 0;
    let safety = 0;

    while (nextUrl && safety < SocialGraphBackfillService.PAGE_SAFETY) {
      safety += 1;
      const response = await fetchJson<any>(nextUrl);
      const page: any[] = response?.data ?? [];

      const missing: Tx[] = [];
      for (const raw of page) {
        const hash: string | undefined = raw?.hash;
        if (!hash || raw?.tx?.type !== 'ContractCallTx') {
          continue;
        }
        const existing = await this.txRepository.findOne({
          where: { hash },
          select: ['hash'],
        });
        if (existing) {
          skipped += 1;
          continue;
        }
        const entity = this.buildContractCallTxEntity(
          camelcaseKeysDeep(raw) as ITransaction,
        );
        if (entity) {
          missing.push(entity as Tx);
        }
      }

      if (missing.length > 0) {
        const persisted = await this.txRepository.save(missing);
        await this.plugin.processBatch(persisted, SyncDirectionEnum.Backward);
        saved += persisted.length;
      }

      nextUrl = resolveMiddlewareNextUrlSafely(
        typeof response?.next === 'string' ? response.next : null,
        middlewareUrl,
        this.logger,
        'SocialGraphBackfillService.backfill',
      );
    }

    if (nextUrl && safety >= SocialGraphBackfillService.PAGE_SAFETY) {
      this.logger.warn(
        `social-graph backfill hit the page safety limit (${SocialGraphBackfillService.PAGE_SAFETY}); remaining pages were not scanned`,
      );
    }

    if (saved > 0 || skipped > 0) {
      this.logger.log(
        `social-graph backfill complete: saved ${saved}, already-present ${skipped}`,
      );
    }
    return { saved, skipped };
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

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
import {
  SOCIAL_GRAPH_CONTRACT_ADDRESS,
  SOCIAL_GRAPH_ENABLED,
} from '../social-graph.constants';

/**
 * Re-decodes and replays the contract's calls from the middleware to recover
 * follows the indexer stored but decoded to zero events (or never stored).
 * Idempotent per boot: edges ON CONFLICT DO NOTHING, counts recomputed.
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
   * Walk the contract's calls, save any the indexer never persisted, and hand
   * EVERY tx on each page to the plugin — a tx stored before the decode fix is
   * in `txs` but has zero edges, so skipping stored txs would strand exactly the
   * follows we need to recover. Idempotent, so re-decoding a stored tx is safe.
   */
  async backfill(): Promise<{ saved: number; reprocessed: number }> {
    const middlewareUrl = this.getMiddlewareUrl();
    // Every call to the contract post-dates its deploy, so scoping to the
    // contract already bounds the walk to the graph's own history.
    let nextUrl: string | null = resolveMiddlewareNextUrl(
      `/v3/transactions?type=contract_call&contract=${SOCIAL_GRAPH_CONTRACT_ADDRESS}` +
        `&direction=forward&limit=100`,
      middlewareUrl,
    );

    let saved = 0;
    let reprocessed = 0;
    let safety = 0;

    while (nextUrl && safety < SocialGraphBackfillService.PAGE_SAFETY) {
      safety += 1;
      const response = await fetchJson<any>(nextUrl);
      const page: any[] = response?.data ?? [];

      const rows = page.filter(
        (raw) => raw?.hash && raw?.tx?.type === 'ContractCallTx',
      );
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

    if (reprocessed > 0) {
      this.logger.log(
        `social-graph backfill complete: saved ${saved}, reprocessed ${reprocessed}`,
      );
    }
    return { saved, reprocessed };
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

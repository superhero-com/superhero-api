import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { ACTIVE_NETWORK } from '@/configs';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { toMdwTx } from '@/mdw-sync/utils/to-mdw-tx';
import { resolveMiddlewareNextUrl } from '@/utils/common';
import { ITransaction } from '@/utils/types';
import {
  ShortsIndexService,
  SHORTS_INDEX_VERSION,
} from '@/shorts/shorts-index.service';
import { ShortsGateway } from '@/shorts/shorts.gateway';
import { ShortsPluginSyncService } from './shorts-plugin-sync.service';
import { SyncDirectionEnum } from '../plugin.interface';

// Durable contract coverage driven by the shared MDW sync loop. Websocket
// delivery remains the low-latency path; this closes gaps after any interruption.
@Injectable()
export class ShortsBackfillService {
  constructor(
    private readonly db: DataSource,
    private readonly config: ConfigService,
    private readonly ae: AeSdkService,
    private readonly index: ShortsIndexService,
    private readonly processor: ShortsPluginSyncService,
    private readonly gateway: ShortsGateway,
  ) {}

  async run(tipHeight: number, stopped: () => boolean) {
    if (!Number.isSafeInteger(tipHeight) || tipHeight < 1)
      throw new Error('Invalid middleware tip height');
    // The current generation can still gain microblocks. Never checkpoint it.
    const closedHeight = tipHeight - 1;
    let changed = false;
    const base =
      this.config.get<string>('mdw.middlewareUrl') ||
      ACTIVE_NETWORK.middlewareUrl;
    const repository = this.db.getRepository(Tx);
    for (const instance of this.index.contracts()) {
      const contract = instance.$options.address;
      if (stopped()) return;
      await this.db.query(
        `INSERT INTO shorts_index_backfill(contract,version) VALUES($1,$2)
        ON CONFLICT(contract) DO UPDATE SET version=$2,cursor=null,complete=false,
        covered_height=-1,target_height=null,from_height=null,updated_at=now()
        WHERE shorts_index_backfill.version != $2`,
        [contract, SHORTS_INDEX_VERSION],
      );
      const [state] = await this.db.query(
        'SELECT * FROM shorts_index_backfill WHERE contract=$1',
        [contract],
      );
      if (state.complete && state.covered_height >= closedHeight) continue;
      // An unfinished range has a fixed end and durable page cursor. A newer tip
      // cannot cause its remaining pages to be skipped after a retry/restart.
      const from = state.from_height ?? state.covered_height + 1;
      const target = state.target_height ?? closedHeight;
      if (target > closedHeight)
        throw new Error('Middleware tip moved behind pending coverage');
      const scope = `gen:${from}-${target}`;
      const initial = `/v3/contracts/logs?contract_id=${contract}&direction=forward&limit=100&scope=${scope}`;
      let cursor: string | null = state.cursor || initial;
      await this.db.query(
        'UPDATE shorts_index_backfill SET complete=false,from_height=$2,target_height=$3,cursor=$4 WHERE contract=$1',
        [contract, from, target, cursor],
      );
      // Bound each shared tick; a busy contract resumes on the next one.
      let pages = 0;
      while (cursor && !stopped() && pages++ < 10) {
        const url = resolveMiddlewareNextUrl(cursor, base);
        if (
          !url ||
          new URL(url).pathname !==
            `${new URL(base).pathname.replace(/\/$/, '')}/v3/contracts/logs`
        )
          throw new Error('Invalid Shorts backfill cursor');
        const params = new URL(url).searchParams;
        if (
          params.get('contract_id') !== contract ||
          params.get('scope') !== scope ||
          params.get('direction') !== 'forward' ||
          params.get('limit') !== '100'
        )
          throw new Error('Shorts cursor changed its coverage range');
        const response = await fetch(url, {
          signal: AbortSignal.timeout(15000),
          redirect: 'error',
        });
        if (!response.ok)
          throw new Error(`Shorts backfill HTTP ${response.status}`);
        const page = await response.json();
        if (
          !Array.isArray(page.data) ||
          page.data.length > 100 ||
          (page.next !== null && typeof page.next !== 'string')
        )
          throw new Error('Invalid Shorts backfill page');
        if (page.next === cursor || page.next === url)
          throw new Error('Shorts backfill cursor did not advance');
        const hashes = [
          ...new Set<string>(page.data.map((log) => log.call_tx_hash)),
        ];
        for (const hash of hashes) {
          if (stopped()) return;
          if (!/^th_[1-9A-HJ-NP-Za-km-z]+$/.test(hash))
            throw new Error('Invalid Shorts backfill transaction');
          const txResponse = await fetch(
            `${base.replace(/\/$/, '')}/v3/transactions/${hash}`,
            { signal: AbortSignal.timeout(15000), redirect: 'error' },
          );
          if (!txResponse.ok)
            throw new Error('Shorts backfill transaction unavailable');
          const raw = await txResponse.json();
          const tx = toMdwTx(camelcaseKeysDeep(raw) as ITransaction) as Tx;
          if (
            tx.hash !== hash ||
            tx.block_height < from ||
            tx.block_height > target ||
            tx.type !== 'ContractCallTx' ||
            !tx.raw?.log?.some((log) => log.address === contract)
          )
            throw new Error('Unexpected Shorts backfill contract');
          // Do not restore an orphan from a lagging middleware during startup.
          const generation = await this.ae.sdk.api.getGenerationByHeight(
            tx.block_height,
          );
          if (!generation.microBlocks.includes(tx.block_hash as `mh_${string}`))
            throw new Error('Shorts backfill is reorganizing');
          await repository.upsert(tx, ['hash']);
          await this.processor.processTransaction(
            tx,
            SyncDirectionEnum.Backward,
          );
        }
        cursor = page.next;
        // Advance only after the entire page committed. Restart/retry may replay
        // a page; per-transaction replacement makes that harmless.
        await this.db.query(
          `UPDATE shorts_index_backfill SET cursor=$2,complete=$3,updated_at=now(),
          covered_height=CASE WHEN $3 THEN $4 ELSE covered_height END,
          from_height=CASE WHEN $3 THEN NULL ELSE from_height END,
          target_height=CASE WHEN $3 THEN NULL ELSE target_height END WHERE contract=$1`,
          [contract, cursor, cursor === null, target],
        );
        changed = true;
      }
    }
    if (changed && !stopped()) await this.gateway.changed();
  }
}

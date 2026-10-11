import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ShortsChainService, ae } from './shorts-chain.service';
import { LedgerReport, ShortsLedgerService } from './shorts-ledger.service';

export const SHORTS_INDEX_VERSION = 1;
export const SHORTS_UPDATES_CHANNEL = 'shorts_updated';
export const SHORTS_PLUGIN = 'SHORTS_MDW_PLUGIN';

@Injectable()
export class ShortsIndexService extends ShortsLedgerService {
  readonly realtime = true;
  constructor(
    private readonly db: DataSource,
    private readonly chain: ShortsChainService,
  ) {
    super();
  }

  contracts() {
    return [this.chain.contract, this.chain.previous].filter(Boolean);
  }

  async removed(hashes: string[]) {
    await this.db.query(
      "DELETE FROM plugin_failed_transaction f WHERE plugin_name='shorts' AND tx_hash=ANY($1::text[]) AND NOT EXISTS(SELECT 1 FROM txs WHERE hash=f.tx_hash)",
      [hashes],
    );
  }

  identity() {
    return {
      network: 'ae_uat',
      contract: this.chain.contract.$options.address,
    };
  }

  async report(
    actor: string,
    start: number,
    end: number,
    shortId?: string,
  ): Promise<LedgerReport> {
    const contracts = this.contracts().map(
      (contract) => contract.$options.address,
    );
    // Repeatable-read keeps counts and rows on the same canonical snapshot if a
    // reorg deletes txs while this report is being assembled. The FK cascades.
    return this.db.transaction('REPEATABLE READ', async (manager) => {
      const [sync] = await manager.query(
        "SELECT tip_height, updated_at FROM sync_state WHERE id='global'",
      );
      const height = Number(sync?.tip_height ?? -1);
      const syncedAt = sync ? new Date(sync.updated_at).getTime() : 0;
      const [health] = await manager.query(
        `SELECT
        (SELECT COUNT(*) FROM shorts_index_backfill WHERE contract=ANY($1::text[]) AND version=$2 AND complete) AS complete,
        (EXISTS(SELECT 1 FROM plugin_failed_transaction WHERE plugin_name='shorts') OR EXISTS(SELECT 1 FROM txs WHERE (contract_id=ANY($1::text[]) OR data ? 'shorts') AND type='ContractCallTx' AND (data->'shorts'->>'_version') IS DISTINCT FROM $2::text)) AS failed`,
        [contracts, SHORTS_INDEX_VERSION],
      );
      const stale =
        Number(health.complete) !== contracts.length ||
        health.failed ||
        Date.now() - syncedAt > 120000;
      const where =
        'beneficiary=$1 AND contract=ANY($2::text[]) AND ($3::text IS NULL OR short_id=$3)';
      const params = [actor, contracts, shortId ?? null];
      const [totals] = await manager.query(
        `SELECT
        COALESCE(SUM(amount) FILTER(WHERE action='PaidLike' AND block_height <= $4 AND at >= $5 AND at < $6),0)::text AS earned,
        COUNT(*) FILTER(WHERE action='PaidLike' AND block_height <= $4 AND at >= $5 AND at < $6)::int AS likes,
        COUNT(*) FILTER(WHERE block_height > $4)::int AS pending,
        COUNT(*)::int AS count
        FROM shorts_chain_events WHERE ${where}`,
        [...params, height - 2, start, end],
      );
      const days = await manager.query(
        `SELECT (floor(at::numeric/86400000)*86400000)::text AS at,
        SUM(amount)::text AS amount,COUNT(*)::int AS likes FROM shorts_chain_events WHERE ${where}
        AND action='PaidLike' AND block_height <= $4 AND at >= $5 AND at < $6 GROUP BY 1 ORDER BY 1`,
        [...params, height - 2, start, end],
      );
      const rows = await manager.query(
        `SELECT * FROM shorts_chain_events WHERE ${where}
        ORDER BY at DESC, tx_hash, log_index LIMIT 200`,
        params,
      );
      return {
        syncedAt,
        stale,
        message: stale
          ? 'Chain history is catching up. Live balances remain separate.'
          : '',
        confirmationsRequired: 3,
        earned: ae(totals.earned),
        paidLikes: totals.likes,
        pending: totals.pending,
        truncated: totals.count > rows.length,
        series: days.map((day) => ({
          at: Number(day.at),
          earnedAe: ae(day.amount),
          paidLikes: day.likes,
        })),
        entries: rows.map((row) => {
          const confirmations = Math.max(0, height - row.block_height + 1);
          return {
            id: `${row.contract}:${row.tx_hash}:${row.log_index}`,
            tx: row.tx_hash,
            at: Number(row.at),
            height: row.block_height,
            confirmations,
            action: row.action,
            actor: row.actor,
            beneficiary: row.beneficiary,
            amount: row.amount,
            amountAe: ae(row.amount),
            shortId: row.short_id ?? undefined,
            source: row.contract,
            confirmed: confirmations >= 3,
          };
        }),
      };
    });
  }
}

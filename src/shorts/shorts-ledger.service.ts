import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ShortsChainService, ae } from './shorts-chain.service';
import { ShortsStoreService } from './shorts-store.service';

export interface LedgerEntry {
  id: string;
  tx: string;
  at: number;
  height: number;
  confirmations: number;
  action: string;
  actor: string;
  beneficiary: string;
  amount: string;
  shortId?: string;
  source?: string;
}
@Injectable()
export class ShortsLedgerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer: ReturnType<typeof setInterval>;
  private pending: Promise<void> | undefined;
  entries: LedgerEntry[] = [];
  syncedAt = 0;
  error = '';
  constructor(
    private readonly chain: ShortsChainService,
    private readonly store: ShortsStoreService,
  ) {
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS shorts_ledger (id INTEGER PRIMARY KEY, body TEXT NOT NULL, synced INTEGER NOT NULL)',
    );
    const row = store.db
      .prepare('SELECT * FROM shorts_ledger WHERE id=1')
      .get();
    if (row) {
      this.entries = JSON.parse(String(row.body)).filter((entry: LedgerEntry) =>
        ['PaidLike', 'Claimed', 'Published', 'Withdrawn'].includes(
          entry.action,
        ),
      );
      this.syncedAt = Number(row.synced);
    }
  }
  onApplicationBootstrap() {
    void this.sync();
    this.timer = setInterval(() => {
      void this.sync();
    }, 60000);
    this.timer.unref();
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }
  sync() {
    if (this.pending) return this.pending;
    this.pending = this.collect()
      .catch(() => {
        this.error = 'Chain history is delayed. Live balances remain separate.';
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async collectContract(
    contract: NonNullable<ShortsChainService['previous']>,
  ) {
    const base = 'https://testnet.aeternity.io/mdw';
    let next: string | null =
      `/v3/contracts/logs?contract_id=${contract.$options.address}&limit=100`;
    const logs: any[] = [];
    for (let page = 0; next && page < 20; page++) {
      if (!next.startsWith('/v3/contracts/logs?'))
        throw new Error('Invalid history cursor');
      const response = await fetch(base + next, {
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error('History unavailable');
      const body = await response.json();
      logs.push(...body.data);
      next = body.next;
    }
    if (next) throw new Error('History limit reached; full indexer required');
    const height = await this.chain.sdk.getHeight();
    const hashes = [...new Set<string>(logs.map((l) => l.call_tx_hash))];
    const entries: LedgerEntry[] = [];
    // Rebuild this bounded testnet history from node-verified canonical transactions.
    // A reorg removes orphaned entries on the next successful refresh.
    for (let i = 0; i < hashes.length; i += 6) {
      await Promise.all(
        hashes.slice(i, i + 6).map(async (tx) => {
          const [transaction, info] = await Promise.all([
            this.chain.sdk.api.getTransactionByHash(tx as `th_${string}`),
            this.chain.sdk.api.getTransactionInfoByHash(tx),
          ]);
          const call: any = transaction.tx,
            result = info.callInfo;
          if (
            !result ||
            result.returnType !== 'ok' ||
            transaction.blockHeight < 0 ||
            call.contractId !== contract.$options.address
          )
            return;
          const log = logs.find((l) => l.call_tx_hash === tx);
          if (!log || log.block_hash !== transaction.blockHash)
            throw new Error('History is reorganizing');
          const generation = await this.chain.sdk.api.getGenerationByHeight(
            transaction.blockHeight,
          );
          if (
            !generation.microBlocks.includes(
              transaction.blockHash as `mh_${string}`,
            )
          )
            throw new Error('Noncanonical transaction');
          const events = contract.$decodeEvents(
            result.log.map((e) => ({
              ...e,
              address: e.address as `ct_${string}`,
              data: e.data as `cb_${string}`,
            })),
            { omitUnknown: true },
          );
          for (const [index, event] of events.entries()) {
            if (
              !['PaidLike', 'Claimed', 'Published', 'Withdrawn'].includes(
                event.name,
              )
            )
              continue;
            const args: any[] = event.args;
            const row: LedgerEntry = {
              id: `${tx}:${index}`,
              tx,
              at: Number(log.block_time),
              height: transaction.blockHeight,
              confirmations: height - transaction.blockHeight + 1,
              action: event.name,
              actor: call.callerId,
              beneficiary: call.callerId,
              amount: '0',
            };
            if (event.name === 'PaidLike') {
              row.shortId = String(args[2]);
              row.amount = String(args[1]);
              row.beneficiary =
                this.chain.state.shorts.find((s) => s.id === row.shortId)
                  ?.creator || '';
            } else if (event.name === 'Claimed') {
              row.beneficiary = String(args[0]);
              row.amount = String(args[1]);
            } else if (event.name === 'Published') {
              row.beneficiary = String(args[0]);
              row.shortId = String(args[1]);
            } else if (event.name === 'Withdrawn')
              row.shortId = String(args[0]);
            entries.push(row);
          }
        }),
      );
    }
    return entries;
  }
  private async collect() {
    const groups = await Promise.all([
      this.collectContract(this.chain.contract),
      this.chain.previous ? this.collectContract(this.chain.previous) : [],
    ]);
    const entries = groups.flat();
    entries.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
    this.entries = entries;
    this.syncedAt = Date.now();
    this.error = '';
    this.store.db
      .prepare(
        'INSERT INTO shorts_ledger VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,synced=excluded.synced',
      )
      .run(JSON.stringify(entries), this.syncedAt);
  }
  report(actor: string, start: number, end: number, shortId?: string) {
    const own = this.entries.filter(
      (e) => e.beneficiary === actor && (!shortId || e.shortId === shortId),
    );
    const confirmed = own.filter((e) => e.confirmations >= 3);
    const period = confirmed.filter((e) => e.at >= start && e.at < end);
    const earned = period
      .filter((e) => e.action === 'PaidLike')
      .reduce((n, e) => n + BigInt(e.amount), 0n);
    return {
      syncedAt: this.syncedAt,
      stale: !!this.error || Date.now() - this.syncedAt > 120000,
      message: this.error,
      confirmationsRequired: 3,
      earned: ae(earned),
      paidLikes: period.filter((e) => e.action === 'PaidLike').length,
      pending: own.filter((e) => e.confirmations < 3).length,
      entries: own.map((e) => ({
        ...e,
        amountAe: ae(e.amount),
        confirmed: e.confirmations >= 3,
      })),
    };
  }
}

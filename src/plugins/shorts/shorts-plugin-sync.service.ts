import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { BasePluginSyncService } from '../base-plugin-sync.service';
import { SyncDirection, Tx } from '../plugin.interface';
import {
  ShortsIndexService,
  SHORTS_INDEX_VERSION,
  SHORTS_UPDATES_CHANNEL,
} from '@/shorts/shorts-index.service';

@Injectable()
export class ShortsPluginSyncService extends BasePluginSyncService {
  protected readonly logger = new Logger(ShortsPluginSyncService.name);

  constructor(
    ae: AeSdkService,
    private readonly db: DataSource,
    private readonly index: ShortsIndexService,
  ) {
    super(ae);
  }

  async processTransaction(tx: Tx, direction: SyncDirection): Promise<void> {
    void direction;
    const contracts = this.index.contracts();
    const addresses = contracts.map((item) => item.$options.address);
    if (
      tx.type !== 'ContractCallTx' ||
      (!addresses.includes(tx.contract_id as `ct_${string}`) &&
        !tx.raw?.log?.some((log) => addresses.includes(log.address)))
    )
      throw new Error('Unrecognized Shorts contract call');
    if (
      !Number.isSafeInteger(tx.block_height) ||
      tx.block_height < 0 ||
      !/^\d+$/.test(tx.micro_time)
    )
      throw new Error('Unmined Shorts transaction');
    // Only successful calls have accounting effects. Missing execution evidence
    // is retryable, not a success with zero events.
    if (!['ok', 'error', 'revert'].includes(tx.raw?.returnType))
      throw new Error('Missing Shorts execution result');
    const events: {
      contract: string;
      index: number;
      action: string;
      actor: string;
      beneficiary: string;
      amount: string;
      shortId?: string;
    }[] = [];
    if (tx.raw.returnType === 'ok') {
      if (!Array.isArray(tx.raw.log))
        throw new Error('Missing Shorts event logs');
      const logs = this.normalizeEventTopics(tx.raw.log);
      for (const [logIndex, log] of logs.entries()) {
        const contract = contracts.find(
          (item) => item.$options.address === log.address,
        );
        if (!contract) continue;
        const decoded = contract.$decodeEvents([log], { omitUnknown: true });
        for (const event of decoded) {
          if (
            !['Published', 'PaidLike', 'Claimed', 'Withdrawn'].includes(
              event.name,
            )
          )
            continue;
          const args = event.args;
          const actor =
            event.name === 'PaidLike' || event.name === 'Claimed'
              ? String(args[0])
              : tx.caller_id;
          let beneficiary = actor;
          const shortId =
            event.name === 'PaidLike'
              ? String(args[2])
              : event.name === 'Published'
                ? String(args[1])
                : event.name === 'Withdrawn'
                  ? String(args[0])
                  : undefined;
          if (event.name === 'Published') beneficiary = String(args[0]);
          if (event.name === 'PaidLike' || event.name === 'Withdrawn') {
            // Read from the event's own contract, including a previous deployment.
            // It works during reverse/backfill order and for creators absent from
            // this API's local metadata. A missing creator must never lose earnings.
            const { decodedResult: short } = await contract.$call(
              'get_short',
              [shortId],
              { callStatic: true },
            );
            if (!short?.creator) throw new Error('Short creator unavailable');
            beneficiary = String(short.creator);
          }
          const amount = ['PaidLike', 'Claimed'].includes(event.name)
            ? String(args[1])
            : '0';
          if (!/^\d{1,78}$/.test(amount) || !actor || !beneficiary)
            throw new Error('Invalid Shorts accounting event');
          events.push({
            contract: contract.$options.address,
            index: logIndex,
            action: event.name,
            actor,
            beneficiary,
            amount,
            shortId,
          });
        }
      }
    }
    const expected = {
      paid_like: 'PaidLike',
      claim: 'Claimed',
      withdraw: 'Withdrawn',
    }[tx.function];
    if (
      tx.raw.returnType === 'ok' &&
      addresses.includes(tx.contract_id as `ct_${string}`) &&
      expected &&
      !events.some((event) => event.action === expected)
    )
      throw new Error('Missing Shorts accounting event');
    // Decode, projection, version marker and notification commit together. No
    // swallowed decode failures: BasePluginSyncService parks them for shared retry.
    await this.db.transaction(async (manager) => {
      const [canonical] = await manager.query(
        'SELECT block_hash, block_height FROM txs WHERE hash=$1 FOR UPDATE',
        [tx.hash],
      );
      if (
        !canonical ||
        canonical.block_hash !== tx.block_hash ||
        canonical.block_height !== tx.block_height
      )
        throw new Error('Shorts transaction changed during indexing');
      await manager.query(
        'DELETE FROM shorts_chain_events WHERE tx_hash=$1 AND contract=ANY($2::text[])',
        [tx.hash, addresses],
      );
      for (const event of events) {
        await manager.query(
          `INSERT INTO shorts_chain_events (contract,tx_hash,log_index,block_height,at,action,actor,beneficiary,amount,short_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            event.contract,
            tx.hash,
            event.index,
            tx.block_height,
            tx.micro_time,
            event.action,
            event.actor,
            event.beneficiary,
            event.amount,
            event.shortId ?? null,
          ],
        );
      }
      // Preserve other plugins' namespaces even when they index concurrently.
      await manager.query(
        `UPDATE txs SET data=jsonb_set(COALESCE(data,'{}'::jsonb),'{shorts}',$2::jsonb) WHERE hash=$1`,
        [
          tx.hash,
          JSON.stringify({
            _version: SHORTS_INDEX_VERSION,
            data: { events: events.length },
          }),
        ],
      );
      await manager.query(
        "DELETE FROM plugin_failed_transaction WHERE plugin_name='shorts' AND tx_hash=$1",
        [tx.hash],
      );
      await manager.query('SELECT pg_notify($1,$2)', [
        SHORTS_UPDATES_CHANNEL,
        JSON.stringify(this.index.identity()),
      ]);
    });
  }
}

import { ShortsDatabaseService } from './shorts-database.service';
import {
  Inject,
  BadRequestException,
  ConflictException,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { createHash } from 'node:crypto';
import { decode, Encoding, isAddressValid } from '@aeternity/aepp-sdk';
import { isAeEncoded } from '../common/validation/request-validation';
import { ShortsScope } from './shorts-metadata.service';
import { LocalReceipt } from './shorts.types';

export interface ReceiptObservation {
  actor: string;
  tx: string;
  action: 'publish' | 'wallet_transaction';
  calledContract: string;
  verification: 'submitted' | 'node_observed';
  blockHash?: string;
  blockHeight?: number;
}

export function receiptHash(
  value: string,
  prefix: 'th_' | 'mh_' | 'kh_' = 'th_',
) {
  try {
    if (
      isAeEncoded(
        value,
        prefix === 'th_'
          ? Encoding.TxHash
          : prefix === 'kh_'
            ? Encoding.KeyBlockHash
            : Encoding.MicroBlockHash,
      ) &&
      decode(value as `th_${string}`).length === 32
    )
      return value;
  } catch {
    /* Reject malformed or wrong-checksum identifiers before node requests. */
  }
  throw new BadRequestException('Invalid transaction or block hash');
}

/** Activity references only. Canonical accounting belongs to the MDW plugin/index. */
@Injectable()
export class ShortsReceiptsService {
  constructor(
    @Optional() @Inject(ShortsDatabaseService) private readonly db?: DataSource,
  ) {}
  get shared() {
    return !!this.db;
  }
  private transaction<T>(work: (db: EntityManager) => Promise<T>) {
    if (!this.db)
      throw new ServiceUnavailableException(
        'Shared transaction history is unavailable',
      );
    return this.db.transaction(async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'",
      );
      return work(db);
    });
  }
  private scope(scope: ShortsScope) {
    if (
      !['ae_uat', 'ae_mainnet'].includes(scope?.network) ||
      !/^ct_[a-zA-Z0-9]{1,97}$/.test(scope.contract)
    )
      throw new BadRequestException('Invalid Shorts deployment scope');
    return [scope.network, scope.contract];
  }
  private actor(actor: string) {
    if (!isAddressValid(actor, Encoding.AccountAddress))
      throw new BadRequestException('Invalid wallet address');
    return actor;
  }
  private legacy(receipt: LocalReceipt) {
    this.actor(receipt?.actor);
    receiptHash(receipt?.tx);
    if (
      !Number.isSafeInteger(receipt.at) ||
      receipt.at < 0 ||
      typeof receipt.action !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(receipt.action)
    )
      throw new BadRequestException('Invalid historical receipt');
  }
  async initialize(
    scope: ShortsScope,
    sourceHash: string,
    previous: string | undefined,
    legacy: LocalReceipt[],
    allowImport = false,
    rewards: string[] = [],
  ) {
    const params = this.scope(scope);
    if (
      rewards.length > 16 ||
      new Set(rewards).size !== rewards.length ||
      rewards.some(
        (c) =>
          !isAddressValid(c, Encoding.ContractAddress) ||
          [scope.contract, previous].includes(c),
      )
    )
      throw new BadRequestException('Invalid reward receipt targets');
    if (
      !/^[a-f0-9]{64}$/.test(sourceHash) ||
      !Array.isArray(legacy) ||
      (previous !== undefined &&
        (!/^ct_[a-zA-Z0-9]{1,97}$/.test(previous) ||
          previous === scope.contract))
    )
      throw new BadRequestException(
        'Invalid transaction-history configuration',
      );
    const hash = createHash('sha256');
    for (const receipt of legacy) {
      this.legacy(receipt);
      hash.update(
        JSON.stringify([receipt.tx, receipt.actor, receipt.action, receipt.at]),
      );
    }
    const fingerprint = hash.digest('hex');
    return this.transaction(async (db) => {
      const [runtime] = await db.query(
        'SELECT source_hash FROM shorts_runtime WHERE network=$1 AND contract=$2 FOR UPDATE',
        params,
      );
      if (!runtime || runtime.source_hash !== sourceHash)
        throw new ServiceUnavailableException(
          'Transaction-history deployment does not match',
        );
      const [existing] = await db.query(
        'SELECT previous_contract,legacy_hash FROM shorts_receipt_scopes WHERE network=$1 AND contract=$2 FOR UPDATE',
        params,
      );
      if (rewards.length) {
        const [targets] = await db.query(
          'SELECT reward_contracts FROM shorts_receipt_scopes WHERE network=$1 AND contract=$2',
          params,
        );
        if (
          targets &&
          JSON.stringify(targets.reward_contracts) !== JSON.stringify(rewards)
        )
          throw new ConflictException('Reward receipt targets changed');
      }
      if (existing) {
        if (
          existing.previous_contract !== (previous ?? null) ||
          (legacy.length && existing.legacy_hash !== fingerprint)
        )
          throw new ConflictException(
            'Transaction history needs an empty destination and matching migration',
          );
        return;
      }
      if (legacy.length && !allowImport)
        throw new ConflictException(
          'Historical receipts require explicit migration',
        );
      await db.query(
        'INSERT INTO shorts_receipt_scopes(network,contract,previous_contract,legacy_hash) VALUES($1,$2,$3,$4)',
        [...params, previous ?? null, legacy.length ? fingerprint : null],
      );
      if (rewards.length)
        await db.query(
          'UPDATE shorts_receipt_scopes SET reward_contracts=$3::text[] WHERE network=$1 AND contract=$2',
          [...params, rewards],
        );
      for (const r of legacy) {
        const [duplicate] = await db.query(
          'SELECT actor,action FROM shorts_transaction_receipts WHERE network=$1 AND contract=$2 AND tx=$3',
          [...params, r.tx],
        );
        if (
          duplicate &&
          (duplicate.actor !== r.actor || duplicate.action !== r.action)
        )
          throw new ConflictException('Historical receipt identity conflicts');
        await db.query(
          `INSERT INTO shorts_transaction_receipts(network,contract,tx,actor,action,at,verification)
          VALUES($1,$2,$3,$4,$5,$6,'legacy') ON CONFLICT(network,contract,tx) DO UPDATE SET
          at=least(shorts_transaction_receipts.at,excluded.at)`,
          [...params, r.tx, r.actor, r.action, r.at],
        );
      }
    });
  }
  async record(scope: ShortsScope, observation: ReceiptObservation) {
    const params = this.scope(scope);
    receiptHash(observation?.tx);
    this.actor(observation?.actor);
    if (
      !['publish', 'wallet_transaction'].includes(observation.action) ||
      !['submitted', 'node_observed'].includes(observation.verification)
    )
      throw new BadRequestException('Invalid transaction observation');
    if (observation.verification === 'node_observed') {
      receiptHash(observation.blockHash!, 'mh_');
      if (
        !Number.isSafeInteger(observation.blockHeight) ||
        observation.blockHeight! < 0
      )
        throw new BadRequestException('Invalid mined transaction height');
    } else if (
      observation.blockHash !== undefined ||
      observation.blockHeight !== undefined
    )
      throw new BadRequestException('Unverified block evidence');
    return this.transaction(async (db) => {
      const [binding] = await db.query(
        "SELECT previous_contract,to_jsonb(s)->'reward_contracts' AS reward_contracts FROM shorts_receipt_scopes s WHERE network=$1 AND contract=$2",
        params,
      );
      if (!binding)
        throw new ServiceUnavailableException(
          'Transaction history is not initialized',
        );
      if (
        ![
          scope.contract,
          binding.previous_contract,
          ...(binding.reward_contracts ?? []),
        ].includes(observation.calledContract)
      )
        throw new BadRequestException('Unrecognized Shorts contract');
      const args = [
        ...params,
        observation.tx,
        observation.actor,
        observation.action,
        observation.verification,
        observation.calledContract,
        observation.blockHash ?? null,
        observation.blockHeight ?? null,
      ];
      await db.query(
        `INSERT INTO shorts_transaction_receipts(network,contract,tx,actor,action,at,verification,called_contract,block_hash,block_height)
        VALUES($1,$2,$3,$4,$5,floor(extract(epoch FROM clock_timestamp())*1000)::bigint,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        args,
      );
      const [current] = await db.query(
        'SELECT actor,called_contract FROM shorts_transaction_receipts WHERE network=$1 AND contract=$2 AND tx=$3 FOR UPDATE',
        [...params, observation.tx],
      );
      if (
        current.actor !== observation.actor ||
        (current.called_contract &&
          current.called_contract !== observation.calledContract)
      )
        throw new ConflictException('Transaction receipt identity conflicts');
      // A late submission acknowledgement cannot overwrite a stronger observation.
      // Retain the original activity timestamp and any specific historical action.
      await db.query(
        `UPDATE shorts_transaction_receipts SET
        action=CASE WHEN $5='publish' THEN $5 ELSE action END,
        verification=CASE WHEN verification='node_observed' THEN verification ELSE $6 END,
        called_contract=$7,
        block_hash=CASE WHEN $6='node_observed' THEN $8 ELSE block_hash END,
        block_height=CASE WHEN $6='node_observed' THEN $9 ELSE block_height END,
        recorded_at=clock_timestamp()
        WHERE network=$1 AND contract=$2 AND tx=$3 AND actor=$4`,
        args,
      );
    });
  }
  async list(
    scope: ShortsScope,
    actor: string,
    limit = 15,
    before?: { at: number; tx: string },
  ) {
    this.actor(actor);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (before && (!Number.isSafeInteger(before.at) || before.at < 0))
    )
      throw new BadRequestException('Invalid receipt page');
    if (before) receiptHash(before.tx);
    return this.transaction(async (db) => {
      const rows = await db.query(
        `SELECT tx,actor,action,at,verification,called_contract,block_hash,block_height,recorded_at
        FROM shorts_transaction_receipts WHERE network=$1 AND contract=$2 AND actor=$3
        AND ($4::bigint IS NULL OR (at,tx)<($4,$5)) ORDER BY at DESC,tx DESC LIMIT $6`,
        [
          ...this.scope(scope),
          actor,
          before?.at ?? null,
          before?.tx ?? null,
          limit + 1,
        ],
      );
      const items = rows.slice(0, limit).map((row) => ({
        tx: row.tx,
        actor: row.actor,
        action: row.action,
        at: Number(row.at),
        verification: row.verification,
        contract: row.called_contract ?? undefined,
        blockHash: row.block_hash ?? undefined,
        blockHeight:
          row.block_height === null ? undefined : Number(row.block_height),
        recordedAt: new Date(row.recorded_at).getTime(),
      }));
      const last = items.at(-1);
      return {
        items,
        next:
          rows.length > limit && last
            ? { at: last.at, tx: last.tx }
            : undefined,
      };
    });
  }
}

import { ShortsDatabaseService } from './shorts-database.service';
import {
  Inject,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  isAeAccountAddress,
  isAeContractAddress,
} from '../common/validation/request-validation';
import { ShortsScope } from './shorts-metadata.service';
import { ShortRecord } from './shorts.types';
import { officialContentPolicy } from './shorts-eligibility';
import { receiptHash } from './shorts-receipts.service';
import {
  PublicationIntent,
  PublishingPolicy,
  publicationTransaction,
  publishingPolicy,
} from './shorts-publication-transaction';

export interface PublicationClaim {
  id: string;
  token: string;
  fence: string;
  intent: PublicationIntent;
  status: 'claimed' | 'signed';
  rawTransaction?: string;
  transactionHash?: string;
}

/** Durable publication journal. No key, media access or network client lives here. */
@Injectable()
export class ShortsPublicationsService {
  constructor(@Inject(ShortsDatabaseService) private readonly db: DataSource) {}
  private scope(scope: ShortsScope) {
    if (scope?.network !== 'ae_uat' || !isAeContractAddress(scope.contract))
      throw new BadRequestException(
        'Publication journal requires a testnet contract',
      );
    return [scope.network, scope.contract];
  }
  private transaction<T>(work: (db: EntityManager) => Promise<T>) {
    return this.db.transaction(async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'",
      );
      return work(db);
    });
  }
  async initialize(
    scope: ShortsScope,
    sourceHash: string,
    operator: string,
    limits: PublishingPolicy,
  ) {
    const params = this.scope(scope),
      policy = publishingPolicy(limits);
    if (!/^[a-f0-9]{64}$/.test(sourceHash) || !isAeAccountAddress(operator))
      throw new BadRequestException('Invalid publisher identity');
    await this.transaction(async (db) => {
      const [runtime] = await db.query(
        'SELECT source_hash FROM shorts_runtime WHERE network=$1 AND contract=$2 FOR UPDATE',
        params,
      );
      if (runtime?.source_hash !== sourceHash)
        throw new ConflictException(
          'Publisher source does not match the runtime',
        );
      await db.query(
        `INSERT INTO shorts_publishing_accounts(network,operator,policy) VALUES($1,$2,$3::jsonb)
        ON CONFLICT DO NOTHING`,
        [scope.network, operator, JSON.stringify(policy)],
      );
      const [account] = await db.query(
        'SELECT policy FROM shorts_publishing_accounts WHERE network=$1 AND operator=$2 FOR UPDATE',
        [scope.network, operator],
      );
      if (
        JSON.stringify(publishingPolicy(account.policy)) !==
        JSON.stringify(policy)
      )
        throw new ConflictException(
          'Publisher account limits need explicit reconciliation',
        );
      await db.query(
        `INSERT INTO shorts_publishing_contracts(network,contract,operator,source_hash) VALUES($1,$2,$3,$4)
        ON CONFLICT DO NOTHING`,
        [...params, operator, sourceHash],
      );
      const [binding] = await db.query(
        'SELECT operator,source_hash FROM shorts_publishing_contracts WHERE network=$1 AND contract=$2',
        params,
      );
      if (binding.operator !== operator || binding.source_hash !== sourceHash)
        throw new ConflictException('Publisher deployment identity changed');
    });
  }
  private async account(db: EntityManager, scope: ShortsScope) {
    const [account] = await db.query(
      `SELECT a.operator,a.policy,a.paused FROM shorts_publishing_contracts c
      JOIN shorts_publishing_accounts a ON (a.network,a.operator)=(c.network,c.operator)
      JOIN shorts_runtime r ON (r.network,r.contract,r.source_hash)=(c.network,c.contract,c.source_hash)
      WHERE c.network=$1 AND c.contract=$2 FOR UPDATE OF a`,
      this.scope(scope),
    );
    if (!account)
      throw new ServiceUnavailableException(
        'Publisher is not initialized for this deployment',
      );
    account.policy = publishingPolicy(account.policy);
    return account as {
      operator: string;
      policy: PublishingPolicy;
      paused: boolean;
    };
  }
  private intent(record: ShortRecord): PublicationIntent {
    if (
      !record ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(record.id) ||
      !isAeAccountAddress(record.creator) ||
      typeof record.cid !== 'string' ||
      !/^[a-zA-Z0-9]{1,120}$/.test(record.cid) ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 1 ||
      record.bytes > 100000000
    )
      throw new BadRequestException('Invalid publication content');
    return {
      id: record.id,
      creator: record.creator,
      cid: record.cid,
      bytes: record.bytes,
    };
  }
  private async content(db: EntityManager, scope: ShortsScope, id: string) {
    const [row] = await db.query(
      'SELECT body FROM shorts_content WHERE network=$1 AND contract=$2 AND id=$3 FOR UPDATE',
      [...this.scope(scope), id],
    );
    return row?.body as ShortRecord | undefined;
  }
  private permitted(
    record: ShortRecord | undefined,
    intent: PublicationIntent,
  ) {
    return (
      !!record &&
      record.publication === 'pending' &&
      officialContentPolicy(record).publish &&
      record.id === intent.id &&
      record.creator === intent.creator &&
      record.cid === intent.cid &&
      record.bytes === intent.bytes
    );
  }
  async enqueue(scope: ShortsScope, id: string, creator: string) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id) || !isAeAccountAddress(creator))
      throw new BadRequestException('Invalid publication request');
    return this.transaction(async (db) => {
      const account = await this.account(db, scope),
        content = await this.content(db, scope, id);
      if (content?.creator !== creator)
        throw new ForbiddenException(
          'Only the creator may request publication',
        );
      const intent = this.intent(content);
      const [existing] = await db.query(
        'SELECT intent,status,tx_hash FROM shorts_publication_jobs WHERE network=$1 AND contract=$2 AND id=$3',
        [...this.scope(scope), id],
      );
      if (existing) {
        if (
          Object.keys(intent).some(
            (key) => existing.intent[key] !== intent[key],
          )
        )
          throw new ConflictException(
            'Publication identity cannot be replaced',
          );
        return {
          status: existing.status,
          transactionHash: existing.tx_hash ?? undefined,
        };
      }
      if (account.paused)
        throw new ServiceUnavailableException('Publication is paused');
      if (!this.permitted(content, intent))
        throw new ForbiddenException('Publication requires current approval');
      const [{ pending, own }] = await db.query(
        `SELECT count(*)::integer AS pending,
        count(*) FILTER(WHERE creator=$3)::integer AS own FROM shorts_publication_jobs
        WHERE network=$1 AND operator=$2 AND status IN ('queued','claimed','signed')`,
        [scope.network, account.operator, creator],
      );
      if (
        pending >= account.policy.maxPending ||
        own >= account.policy.maxCreatorPending
      )
        throw new ServiceUnavailableException('Publication queue is full');
      await db.query(
        `INSERT INTO shorts_publication_jobs(network,contract,id,operator,creator,intent)
        VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          ...this.scope(scope),
          id,
          account.operator,
          creator,
          JSON.stringify(intent),
        ],
      );
      return { status: 'queued', transactionHash: undefined };
    });
  }
  private result(row: any): PublicationClaim {
    return {
      id: row.id,
      token: row.lease_token,
      fence: row.fence.toString(),
      intent: row.intent,
      status: row.status,
      rawTransaction: row.raw_tx ?? undefined,
      transactionHash: row.tx_hash ?? undefined,
    };
  }
  async claim(scope: ShortsScope): Promise<PublicationClaim | undefined> {
    return this.transaction(async (db) => {
      const account = await this.account(db, scope);
      const [active] = await db.query(
        `SELECT * FROM shorts_publication_jobs
        WHERE network=$1 AND operator=$2 AND status IN ('claimed','signed') FOR UPDATE`,
        [scope.network, account.operator],
      );
      const [{ now }] = await db.query('SELECT clock_timestamp() AS now');
      if (
        active &&
        (active.contract !== scope.contract || active.lease_until > now)
      )
        return;
      if (!active && account.paused) return;
      const [queued] = active
        ? []
        : await db.query(
            `SELECT * FROM shorts_publication_jobs
        WHERE network=$1 AND contract=$2 AND status='queued' ORDER BY created_at,id LIMIT 1 FOR UPDATE`,
            this.scope(scope),
          );
      const row = active ?? queued;
      if (!row) return;
      if (
        row.status !== 'signed' &&
        !this.permitted(await this.content(db, scope, row.id), row.intent)
      ) {
        await db.query(
          `UPDATE shorts_publication_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
          WHERE network=$1 AND contract=$2 AND id=$3`,
          [...this.scope(scope), row.id],
        );
        return;
      }
      // Signed bytes stay attached to this job after lease expiry. No second job
      // for the same operator can proceed while its outcome is unresolved.
      const [rows] = await db.query(
        `UPDATE shorts_publication_jobs SET
        status=CASE WHEN raw_tx IS NULL THEN 'claimed' ELSE 'signed' END,
        fence=fence+1,lease_token=$4,lease_until=clock_timestamp()+$5*interval '1 millisecond',updated_at=clock_timestamp()
        WHERE network=$1 AND contract=$2 AND id=$3 RETURNING *`,
        [...this.scope(scope), row.id, randomUUID(), account.policy.leaseMs],
      );
      return this.result(rows[0]);
    });
  }
  private async locked(
    db: EntityManager,
    scope: ShortsScope,
    claim: PublicationClaim,
  ) {
    const [row] = await db.query(
      `SELECT * FROM shorts_publication_jobs
      WHERE network=$1 AND contract=$2 AND id=$3 FOR UPDATE`,
      [...this.scope(scope), claim.id],
    );
    const [{ now }] = await db.query('SELECT clock_timestamp() AS now');
    if (
      !row ||
      !['claimed', 'signed'].includes(row.status) ||
      !(row.lease_until > now) ||
      row.lease_token !== claim.token ||
      row.fence.toString() !== claim.fence
    )
      throw new ConflictException('Publication lease expired or was replaced');
    return row;
  }
  private async change(
    db: EntityManager,
    scope: ShortsScope,
    claim: PublicationClaim,
    set: string,
    values: unknown[] = [],
  ) {
    const [rows, count] = await db.query(
      `UPDATE shorts_publication_jobs SET ${set},updated_at=clock_timestamp()
      WHERE network=$1 AND contract=$2 AND id=$3 AND lease_until>clock_timestamp() RETURNING *`,
      [...this.scope(scope), claim.id, ...values],
    );
    if (count !== 1) throw new ConflictException('Publication lease expired');
    return rows[0];
  }
  async renew(scope: ShortsScope, claim: PublicationClaim) {
    return this.transaction(async (db) => {
      const account = await this.account(db, scope);
      await this.locked(db, scope, claim);
      await this.change(
        db,
        scope,
        claim,
        "lease_until=clock_timestamp()+$4*interval '1 millisecond'",
        [account.policy.leaseMs],
      );
    });
  }
  async persistSigned(
    scope: ShortsScope,
    claim: PublicationClaim,
    raw: string,
    accountNonce: number,
    height: number,
  ) {
    return this.transaction(async (db) => {
      const account = await this.account(db, scope),
        row = await this.locked(db, scope, claim);
      if (row.status === 'signed') {
        if (row.raw_tx !== raw)
          throw new ConflictException(
            'A signed publication transaction cannot be replaced',
          );
        return this.result(row);
      }
      if (account.paused)
        throw new ServiceUnavailableException('Publication is paused');
      if (!this.permitted(await this.content(db, scope, row.id), row.intent))
        throw new ForbiddenException('Publication approval changed');
      const tx = publicationTransaction(
        raw,
        row.intent,
        scope.contract,
        account.operator,
        accountNonce,
        height,
        account.policy,
        scope.network,
      );
      const [{ nonce, cost }] = await db.query(
        `SELECT (SELECT nonce FROM shorts_publication_jobs WHERE network=$1 AND operator=$2 AND nonce IS NOT NULL
          ORDER BY nonce DESC LIMIT 1) AS nonce,
        (SELECT coalesce(sum(reserved_cost),0)::text FROM shorts_publication_jobs WHERE network=$1 AND operator=$2
          AND (signed_at>statement_timestamp()-interval '24 hours' OR status='signed')) AS cost`,
        [scope.network, account.operator],
      );
      if (nonce !== null && BigInt(accountNonce) < BigInt(nonce))
        throw new ConflictException(
          'Node nonce is behind the durable publication journal',
        );
      if (
        BigInt(cost) + BigInt(tx.cost) >
        BigInt(account.policy.rollingCostLimit)
      )
        throw new ServiceUnavailableException(
          'Publication spending limit reached',
        );
      return this.result(
        await this.change(
          db,
          scope,
          claim,
          "status='signed',raw_tx=$4,tx_hash=$5,nonce=$6,ttl=$7,reserved_cost=$8,signed_at=clock_timestamp()",
          [raw, tx.hash, tx.nonce, tx.ttl, tx.cost],
        ),
      );
    });
  }
  async authorizeBroadcast(scope: ShortsScope, claim: PublicationClaim) {
    return this.transaction(async (db) => {
      const account = await this.account(db, scope),
        row = await this.locked(db, scope, claim);
      if (row.status !== 'signed')
        throw new ConflictException('Save signed bytes before broadcast');
      if (account.paused) return undefined;
      const allowed =
        !row.broadcast_blocked &&
        this.permitted(await this.content(db, scope, row.id), row.intent);
      // Once content loses permission, only reconciliation is allowed. Never
      // discard an uncertain signed transaction or silently free its nonce.
      if (!allowed) {
        await this.change(db, scope, claim, 'broadcast_blocked=true');
        return undefined;
      }
      await this.change(
        db,
        scope,
        claim,
        'broadcast_attempts=broadcast_attempts+1,last_broadcast_at=clock_timestamp()',
      );
      return {
        rawTransaction: row.raw_tx as string,
        transactionHash: row.tx_hash as string,
      };
    });
  }
  /** Called only with a fresh, independently verified canonical node observation. */
  async settle(
    scope: ShortsScope,
    claim: PublicationClaim,
    proof: {
      transactionHash: string;
      blockHash: string;
      height: number;
      tipHeight: number;
      result: 'ok' | 'revert' | 'error';
    },
  ) {
    receiptHash(proof.transactionHash);
    receiptHash(proof.blockHash, 'mh_');
    if (
      !Number.isSafeInteger(proof.height) ||
      proof.height < 0 ||
      !Number.isSafeInteger(proof.tipHeight) ||
      !['ok', 'revert', 'error'].includes(proof.result)
    )
      throw new BadRequestException('Invalid publication observation');
    return this.transaction(async (db) => {
      const account = await this.account(db, scope);
      if (proof.tipHeight - proof.height < account.policy.confirmations)
        throw new ConflictException('Publication outcome is not confirmed');
      const [existing] = await db.query(
        'SELECT status,tx_hash,block_hash,block_height FROM shorts_publication_jobs WHERE network=$1 AND contract=$2 AND id=$3 FOR UPDATE',
        [...this.scope(scope), claim.id],
      );
      if (existing && ['confirmed', 'reverted'].includes(existing.status)) {
        if (
          existing.tx_hash !== proof.transactionHash ||
          existing.block_hash !== proof.blockHash ||
          Number(existing.block_height) !== proof.height ||
          existing.status !== (proof.result === 'ok' ? 'confirmed' : 'reverted')
        )
          throw new ConflictException(
            'Confirmed publication observation conflicts',
          );
        return;
      }
      const row = await this.locked(db, scope, claim);
      if (row.status !== 'signed' || row.tx_hash !== proof.transactionHash)
        throw new ConflictException('Publication outcome is not confirmed');
      await this.change(
        db,
        scope,
        claim,
        'status=$4,block_hash=$5,block_height=$6,lease_token=NULL,lease_until=NULL',
        [
          proof.result === 'ok' ? 'confirmed' : 'reverted',
          proof.blockHash,
          proof.height,
        ],
      );
    });
  }
  async release(scope: ShortsScope, claim: PublicationClaim) {
    return this.transaction(async (db) => {
      await this.account(db, scope);
      await this.locked(db, scope, claim);
      await this.change(
        db,
        scope,
        claim,
        "status=CASE WHEN raw_tx IS NULL THEN 'queued' ELSE 'signed' END,lease_token=NULL,lease_until=NULL",
      );
    });
  }
}

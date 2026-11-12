import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ShortsCleanupDatabaseService } from './shorts-cleanup-database.service';
import type { ShortsScope } from './shorts-metadata.service';
import type { PrivateObjectRef } from './shorts-private-objects.service';
import type { ShortRecord } from './shorts.types';
import { SHORTS_SOURCE_MANIFEST_BYTES } from './shorts-upload-policy';

export interface PrivateInputRetirement {
  sourceKey: string;
  resourceId: string;
  operationId: string;
  rootHash: string;
  referenceEpoch: string;
  objectCount: number;
  retiredAt: string;
}

export interface PrivateInputSnapshot {
  resourceId: string;
  record: ShortRecord;
  refs: PrivateObjectRef[];
  rootHash: string;
  epoch: string;
}

const RECEIPT = `source_key,resource_id,operation_id,root_hash,reference_epoch,
  jsonb_array_length(objects) AS object_count,retired_at`;

/** Immutable verified references only. Never grants object-deletion authority. */
@Injectable()
export class ShortsPrivateInputRetirementsService {
  constructor(
    @Inject(ShortsCleanupDatabaseService) private readonly db: DataSource,
  ) {}

  private args(scope: ShortsScope, id: string, key?: string) {
    if (
      !['ae_uat', 'ae_mainnet'].includes(scope?.network) ||
      !/^ct_[a-zA-Z0-9]{1,97}$/.test(scope.contract) ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(id) ||
      (key !== undefined && !/^[a-f0-9]{64}$/.test(key))
    )
      throw new Error('Invalid private retirement identity');
    return key === undefined
      ? [scope.network, scope.contract, id]
      : [scope.network, scope.contract, id, key];
  }

  private receipt(row: Record<string, string>): PrivateInputRetirement {
    return {
      sourceKey: row.source_key,
      resourceId: row.resource_id,
      operationId: row.operation_id,
      rootHash: row.root_hash,
      referenceEpoch: String(row.reference_epoch),
      objectCount: Number(row.object_count),
      retiredAt: new Date(row.retired_at).toISOString(),
    };
  }

  async operation(scope: ShortsScope, id: string, operation: string) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        operation,
      )
    )
      throw new Error('Invalid private retirement operation');
    const [row] = await this.db.query(
      `SELECT ${RECEIPT} FROM shorts_private_input_retirements
        WHERE network=$1 AND contract=$2 AND short_id=$3 AND operation_id=$4`,
      [...this.args(scope, id), operation],
    );
    return row ? this.receipt(row) : undefined;
  }

  match(receipt: PrivateInputRetirement, key: string) {
    if (!/^[a-f0-9]{64}$/.test(key) || receipt.sourceKey !== key)
      throw new ConflictException(
        'Private retirement operation was already used',
      );
    return receipt;
  }

  async snapshot(
    scope: ShortsScope,
    id: string,
    key: string,
  ): Promise<PrivateInputSnapshot> {
    return this.db.transaction('READ COMMITTED', async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'",
      );
      const [{ snapshot }] = await db.query(
        'SELECT shorts_private_input_snapshot($1,$2,$3,$4) AS snapshot',
        this.args(scope, id, key),
      );
      return snapshot;
    });
  }

  /** Call only after verifying durable delivery and authenticating the source manifest. */
  async commit(
    scope: ShortsScope,
    id: string,
    key: string,
    operation: string,
    rootHash: string,
    manifest: string,
  ) {
    const args = this.args(scope, id, key);
    const saved = await this.operation(scope, id, operation);
    if (saved) return this.match(saved, key);
    if (
      !/^[a-f0-9]{64}$/.test(rootHash) ||
      typeof manifest !== 'string' ||
      !manifest.length ||
      Buffer.byteLength(manifest) > SHORTS_SOURCE_MANIFEST_BYTES
    )
      throw new Error('Invalid private retirement proof');
    return this.db.transaction('READ COMMITTED', async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'",
      );
      await db.query('SELECT shorts_private_input_snapshot($1,$2,$3,$4)', args);
      const [repeated] = await db.query(
        `SELECT ${RECEIPT} FROM shorts_private_input_retirements
          WHERE network=$1 AND contract=$2 AND short_id=$3 AND operation_id=$4`,
        [...args.slice(0, 3), operation],
      );
      if (repeated) return this.match(this.receipt(repeated), key);
      const [row] = await db.query(
        `INSERT INTO shorts_private_input_retirements
          (network,contract,short_id,source_key,operation_id,root_hash,source_manifest)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING ${RECEIPT}`,
        [...args, operation, rootHash, manifest],
      );
      if (!row) throw new ConflictException('Private inputs already retired');
      return this.receipt(row);
    });
  }
}

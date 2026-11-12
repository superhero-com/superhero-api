import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ShortsDatabaseService } from './shorts-database.service';
import { ShortsScope } from './shorts-metadata.service';
import { ShortRecord } from './shorts.types';
import { officialContentPolicy } from './shorts-eligibility';
import { shortsDeliverySource } from './shorts-delivery-source';
import { assertDeliveryEligible } from './shorts-delivery-eligibility';
import { shortsPlaybackDescriptor } from './shorts-playback-descriptor';
import { deliverySourceIdentity } from './hls-protocol/playback-descriptor';
import { sourceKey, validateSourcePackage } from './hls-protocol/hls-package';

// Streaming supports at most 3600s tokens + 30s catalog permission cache.
// Keep an additional 90s allowance. Cleanup must honor this database-clock window.
export const SHORTS_DELIVERY_RETAIN_SECONDS = 3720;
export interface DeliveryExpectation {
  sourceKey: string;
  revision: string;
}
export type DeliverySelectionKind = 'activate' | 'rollback';
export interface DeliverySelectionReceipt extends DeliveryExpectation {
  previousSourceKey: string;
  operationId: string;
  kind: DeliverySelectionKind;
  selectedAt: string;
  retainPreviousUntil: string;
}
interface SelectionRow {
  source_key: string;
  from_source_key: string;
  revision: string;
  operation_id: string;
  kind: DeliverySelectionKind;
  selected_at: Date | string;
}

@Injectable()
export class ShortsDeliverySelectionService {
  constructor(@Inject(ShortsDatabaseService) private readonly db: DataSource) {}

  private args(scope: ShortsScope, id: string) {
    if (
      !['ae_uat', 'ae_mainnet'].includes(scope?.network) ||
      !/^ct_[a-zA-Z0-9]{1,97}$/.test(scope.contract) ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(id)
    )
      throw new Error('Invalid selection identity');
    return [scope.network, scope.contract, id];
  }
  private key(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new NotFoundException();
    return key;
  }
  private eligible(original: ShortRecord) {
    if (
      !original ||
      original.publication !== 'published' ||
      !officialContentPolicy(original).serve ||
      original.safety?.sourceSha256 !== shortsDeliverySource(original).sha256
    )
      throw new NotFoundException('Original delivery is not eligible');
  }
  private receipt(row: SelectionRow): DeliverySelectionReceipt {
    return {
      sourceKey: row.source_key,
      previousSourceKey: row.from_source_key,
      revision: String(row.revision),
      operationId: row.operation_id,
      kind: row.kind,
      selectedAt: new Date(row.selected_at).toISOString(),
      retainPreviousUntil: new Date(
        new Date(row.selected_at).getTime() +
          SHORTS_DELIVERY_RETAIN_SECONDS * 1000,
      ).toISOString(),
    };
  }
  private async latest(
    db: DataSource | EntityManager,
    scope: ShortsScope,
    id: string,
  ) {
    const [row] = await db.query(
      `SELECT * FROM shorts_delivery_selections
      WHERE network=$1 AND contract=$2 AND short_id=$3 ORDER BY revision DESC LIMIT 1`,
      this.args(scope, id),
    );
    return row;
  }
  async state(
    scope: ShortsScope,
    original: ShortRecord,
  ): Promise<DeliveryExpectation> {
    const row = await this.latest(this.db, scope, original.id);
    return row
      ? { sourceKey: row.source_key, revision: String(row.revision) }
      : {
          sourceKey: sourceKey(shortsPlaybackDescriptor(original, scope)),
          revision: '0',
        };
  }
  private async version(
    db: DataSource | EntityManager,
    scope: ShortsScope,
    original: ShortRecord,
    key: string,
  ) {
    this.eligible(original);
    const [row] = await db.query(
      `SELECT p.source_identity,p.prepared,p.generation_job_id,g.body
      FROM shorts_delivery_packages p LEFT JOIN shorts_delivery_generations g
        ON g.network=p.network AND g.contract=p.contract AND g.short_id=p.short_id AND g.job_id=p.generation_job_id
      WHERE p.network=$1 AND p.contract=$2 AND p.short_id=$3 AND p.source_key=$4`,
      [...this.args(scope, original.id), this.key(key)],
    );
    if (!row)
      throw new NotFoundException('Acknowledged delivery is unavailable');
    const record: ShortRecord =
      row.generation_job_id === original.id ? original : row.body;
    if (!record)
      throw new NotFoundException('Delivery generation is unavailable');
    if (record.id !== original.id) assertDeliveryEligible(original, record);
    const descriptor = {
      ...shortsPlaybackDescriptor(record, scope),
      id: original.id,
    };
    if (
      sourceKey(descriptor) !== key ||
      deliverySourceIdentity(descriptor) !== row.source_identity
    )
      throw new ConflictException('Selected delivery source changed');
    return {
      record,
      descriptor,
      sourceKey: key,
      prepared: validateSourcePackage(descriptor, row.prepared),
    };
  }
  /** A candidate lookup is for trusted physical verification, not serving. */
  acknowledged(scope: ShortsScope, original: ShortRecord, key: string) {
    return this.version(this.db, scope, original, key);
  }
  async current(scope: ShortsScope, original: ShortRecord) {
    const state = await this.state(scope, original);
    if (state.revision === '0')
      return {
        ...state,
        record: original,
        descriptor: shortsPlaybackDescriptor(original, scope),
      };
    return {
      ...state,
      ...(await this.version(this.db, scope, original, state.sourceKey)),
    };
  }
  async historical(scope: ShortsScope, original: ShortRecord, key: string) {
    this.key(key);
    const [row] = await this.db.query(
      `WITH history AS (
      SELECT * FROM shorts_delivery_selections WHERE network=$1 AND contract=$2 AND short_id=$3
    ) SELECT NOT EXISTS(SELECT FROM history) AS initial,
      (SELECT source_key=$4 FROM history ORDER BY revision DESC LIMIT 1) AS active,
      EXISTS(SELECT FROM history WHERE from_source_key=$4 AND selected_at>clock_timestamp()-interval '${SHORTS_DELIVERY_RETAIN_SECONDS} seconds') AS retained`,
      this.args(scope, original.id).concat(key),
    );
    if (
      row.initial &&
      sourceKey(shortsPlaybackDescriptor(original, scope)) === key
    )
      return {
        record: original,
        descriptor: shortsPlaybackDescriptor(original, scope),
      };
    if (!row.active && !row.retained)
      throw new NotFoundException('Delivery version is no longer retained');
    return this.version(this.db, scope, original, key);
  }
  async operation(scope: ShortsScope, id: string, operation: string) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(operation))
      throw new Error('Invalid selection operation');
    const [row] = await this.db.query(
      `SELECT * FROM shorts_delivery_selections
      WHERE network=$1 AND contract=$2 AND short_id=$3 AND operation_id=$4`,
      [...this.args(scope, id), operation],
    );
    return row ? this.receipt(row) : undefined;
  }
  match(
    receipt: DeliverySelectionReceipt,
    expected: DeliveryExpectation,
    nextKey: string,
    kind: DeliverySelectionKind,
  ) {
    if (
      receipt.sourceKey !== nextKey ||
      receipt.previousSourceKey !== expected.sourceKey ||
      BigInt(receipt.revision) !== BigInt(expected.revision) + 1n ||
      receipt.kind !== kind
    )
      throw new ConflictException('Selection operation was already used');
    return receipt;
  }
  /** Called only after the coordinator verifies physical delivery and on-chain policy. */
  async commit(
    scope: ShortsScope,
    id: string,
    expected: DeliveryExpectation,
    nextKey: string,
    operation: string,
    kind: DeliverySelectionKind,
  ) {
    this.key(expected.sourceKey);
    this.key(nextKey);
    if (
      !/^(0|[1-9][0-9]{0,3})$/.test(expected.revision) ||
      BigInt(expected.revision) >= 1024n ||
      !['activate', 'rollback'].includes(kind)
    )
      throw new ConflictException('Invalid selection transition');
    const existing = await this.operation(scope, id, operation);
    if (existing) return this.match(existing, expected, nextKey, kind);
    return this.db.transaction(async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'",
      );
      const [stored] = await db.query(
        'SELECT body FROM shorts_content WHERE network=$1 AND contract=$2 AND id=$3 FOR UPDATE',
        this.args(scope, id),
      );
      const original: ShortRecord = stored?.body;
      this.eligible(original);
      const [repeated] = await db.query(
        `SELECT * FROM shorts_delivery_selections
        WHERE network=$1 AND contract=$2 AND short_id=$3 AND operation_id=$4`,
        [...this.args(scope, id), operation],
      );
      if (repeated)
        return this.match(this.receipt(repeated), expected, nextKey, kind);
      await this.version(db, scope, original, expected.sourceKey);
      await this.version(db, scope, original, nextKey);
      const [row] = await db.query(
        `INSERT INTO shorts_delivery_selections
        (network,contract,short_id,revision,operation_id,from_source_key,source_key,kind)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          ...this.args(scope, id),
          String(BigInt(expected.revision) + 1n),
          operation,
          expected.sourceKey,
          nextKey,
          kind,
        ],
      );
      return this.receipt(row);
    });
  }
}

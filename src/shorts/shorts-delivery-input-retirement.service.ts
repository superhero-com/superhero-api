import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ShortsDatabaseService } from './shorts-database.service';
import { ShortsScope } from './shorts-metadata.service';

export interface DeliveryInputRetirement {
  sourceKey: string;
  inputCid: string;
  generationJobId: string;
  operationId: string;
  retiredAt: string;
}

/** Logical retirement only; this ledger never authorizes physical deletion. */
@Injectable()
export class ShortsDeliveryInputRetirementService {
  constructor(@Inject(ShortsDatabaseService) private readonly db: DataSource) {}
  private args(scope: ShortsScope, id: string) {
    if (
      !['ae_uat', 'ae_mainnet'].includes(scope?.network) ||
      !/^ct_[a-zA-Z0-9]{1,97}$/.test(scope.contract) ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(id)
    )
      throw new Error('Invalid input retirement identity');
    return [scope.network, scope.contract, id];
  }
  private key(value: string) {
    if (!/^[a-f0-9]{64}$/.test(value))
      throw new Error('Invalid retirement source key');
    return value;
  }
  private receipt(row: Record<string, string>): DeliveryInputRetirement {
    return {
      sourceKey: row.source_key,
      inputCid: row.input_cid,
      generationJobId: row.generation_job_id,
      operationId: row.operation_id,
      retiredAt: new Date(row.retired_at).toISOString(),
    };
  }
  async get(scope: ShortsScope, id: string, key: string) {
    const [row] = await this.db.query(
      `SELECT * FROM shorts_delivery_input_retirements
      WHERE network=$1 AND contract=$2 AND short_id=$3 AND source_key=$4`,
      [...this.args(scope, id), this.key(key)],
    );
    return row ? this.receipt(row) : undefined;
  }
  async operation(scope: ShortsScope, id: string, operation: string) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        operation,
      )
    )
      throw new Error('Invalid retirement operation');
    const [row] = await this.db.query(
      `SELECT * FROM shorts_delivery_input_retirements
      WHERE network=$1 AND contract=$2 AND short_id=$3 AND operation_id=$4`,
      [...this.args(scope, id), operation],
    );
    return row ? this.receipt(row) : undefined;
  }
  match(receipt: DeliveryInputRetirement, key: string) {
    if (receipt.sourceKey !== this.key(key))
      throw new ConflictException('Retirement operation was already used');
    return receipt;
  }
  /** The coordinator must first verify the original, assets and acknowledged HLS. */
  async commit(scope: ShortsScope, id: string, key: string, operation: string) {
    this.key(key);
    const saved = await this.operation(scope, id, operation);
    if (saved) return this.match(saved, key);
    return this.db.transaction(async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'",
      );
      await db.query(
        'SELECT id FROM shorts_content WHERE network=$1 AND contract=$2 AND id=$3 FOR UPDATE',
        this.args(scope, id),
      );
      const [repeated] = await db.query(
        `SELECT * FROM shorts_delivery_input_retirements
        WHERE network=$1 AND contract=$2 AND short_id=$3 AND operation_id=$4`,
        [...this.args(scope, id), operation],
      );
      if (repeated) return this.match(this.receipt(repeated), key);
      const [row] = await db.query(
        `INSERT INTO shorts_delivery_input_retirements
        (network,contract,short_id,source_key,operation_id,input_cid,generation_job_id)
        SELECT network,contract,short_id,source_key,$5,source_identity::jsonb->>'delivery',generation_job_id
        FROM shorts_delivery_packages WHERE network=$1 AND contract=$2 AND short_id=$3 AND source_key=$4
        ON CONFLICT DO NOTHING RETURNING *`,
        [...this.args(scope, id), key, operation],
      );
      if (!row)
        throw new ConflictException(
          'Acknowledged inputs missing or already retired',
        );
      return this.receipt(row);
    });
  }
}

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  bindStorageEpoch,
  storageEpochReceipt,
  StorageWriteEpoch,
} from './shorts-storage-epoch';
import { DataSource } from 'typeorm';
import { ShortsDatabaseService } from './shorts-database.service';
import { ShortsScope } from './shorts-metadata.service';

export type PinPurpose = 'original' | 'assets' | 'inputs' | 'hls';
export interface PinTransferBinding {
  cid: string;
  jobId: string;
  purpose: PinPurpose;
  sourceKey?: string;
}
export interface PinTransfer extends PinTransferBinding, ShortsScope {
  storage?: StorageWriteEpoch & { boundAt: string };
  operationId: string;
  state: 'issued' | 'pinned' | 'rejected' | 'uncertain';
  issuedAt: string;
  expires: number;
  quietUntil: string;
  settledAt: string | null;
}

/** Metadata authority for an expiring write; never grants permission to unpin. */
@Injectable()
export class ShortsPinTransfersService {
  constructor(@Inject(ShortsDatabaseService) private readonly db: DataSource) {}
  private operation(value: string) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        value,
      )
    )
      throw new Error('Invalid pin transfer operation');
    return value;
  }
  private receipt(row: Record<string, any>): PinTransfer {
    return {
      ...storageEpochReceipt(row),
      operationId: row.operation_id,
      cid: row.cid,
      network: row.network,
      contract: row.contract,
      jobId: row.job_id,
      purpose: row.purpose,
      ...(row.source_key ? { sourceKey: row.source_key } : {}),
      state: row.state,
      issuedAt: new Date(row.issued_at).toISOString(),
      expires: new Date(row.expires_at).getTime(),
      quietUntil: new Date(row.quiet_until).toISOString(),
      settledAt: row.settled_at ? new Date(row.settled_at).toISOString() : null,
    };
  }
  async bind(operation: string, storage: StorageWriteEpoch) {
    return this.receipt(
      await bindStorageEpoch(
        this.db,
        'pin',
        this.operation(operation),
        storage,
      ),
    );
  }
  async get(operation: string) {
    const [row] = await this.db.query(
      'SELECT * FROM shorts_pin_transfers WHERE operation_id=$1',
      [this.operation(operation)],
    );
    return row ? this.receipt(row) : undefined;
  }
  async begin(
    scope: ShortsScope,
    binding: PinTransferBinding,
    operation = randomUUID(),
  ) {
    this.operation(operation);
    if (
      !/^b[a-z2-7]{20,118}$/.test(binding.cid) ||
      !/^[a-zA-Z0-9_-]{1,200}$/.test(binding.jobId) ||
      !['original', 'assets', 'inputs', 'hls'].includes(binding.purpose) ||
      (binding.purpose === 'hls'
        ? !/^[a-f0-9]{64}$/.test(binding.sourceKey || '')
        : binding.sourceKey !== undefined)
    )
      throw new Error('Invalid pin transfer binding');
    return this.db.transaction(async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'",
      );
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||$1,0))",
        [binding.cid],
      );
      const [existing] = await db.query(
        'SELECT operation_id FROM shorts_pin_transfers WHERE operation_id=$1',
        [operation],
      );
      if (!existing)
        await db.query(
          `INSERT INTO shorts_pin_transfers(operation_id,cid,network,contract,job_id,purpose,source_key)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [
            operation,
            binding.cid,
            scope.network,
            scope.contract,
            binding.jobId,
            binding.purpose,
            binding.sourceKey ?? null,
          ],
        );
      const [row] = await db.query(
        'SELECT * FROM shorts_pin_transfers WHERE operation_id=$1',
        [operation],
      );
      if (
        !row ||
        row.cid !== binding.cid ||
        row.network !== scope.network ||
        row.contract !== scope.contract ||
        row.job_id !== binding.jobId ||
        row.purpose !== binding.purpose ||
        row.source_key !== (binding.sourceKey ?? null)
      )
        throw new ConflictException('Pin transfer operation was already used');
      return this.receipt(row);
    });
  }
  async finish(operation: string, state: 'pinned' | 'rejected' | 'uncertain') {
    this.operation(operation);
    if (!['pinned', 'rejected', 'uncertain'].includes(state))
      throw new Error('Invalid pin transfer result');
    return this.db.transaction(async (db) => {
      const [saved] = await db.query(
        'SELECT cid FROM shorts_pin_transfers WHERE operation_id=$1',
        [operation],
      );
      if (!saved) throw new NotFoundException('Pin transfer missing');
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||$1,0))",
        [saved.cid],
      );
      await db.query(
        "UPDATE shorts_pin_transfers SET state=$2 WHERE operation_id=$1 AND state='issued'",
        [operation, state],
      );
      const [row] = await db.query(
        'SELECT * FROM shorts_pin_transfers WHERE operation_id=$1',
        [operation],
      );
      if (row.state !== state)
        throw new ConflictException(
          'Pin transfer already has a different outcome',
        );
      return this.receipt(row);
    });
  }
}

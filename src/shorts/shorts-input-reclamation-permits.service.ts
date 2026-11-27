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

export type ReclamationOutcome =
  'removed' | 'not-pinned' | 'rejected' | 'uncertain';
export interface InputReclamationPermit {
  storage?: StorageWriteEpoch & { boundAt: string };
  operationId: string;
  reservationId: string;
  inputCid: string;
  state: 'issued' | ReclamationOutcome;
  issuedAt: string;
  expires: number;
  quietUntil: string;
  settledAt: string | null;
}

/** Durable mutation authority. Issuance alone neither calls IPFS nor proves removal. */
@Injectable()
export class ShortsInputReclamationPermitsService {
  constructor(@Inject(ShortsDatabaseService) private readonly db: DataSource) {}
  private operation(value: string) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        value,
      )
    )
      throw new Error('Invalid reclamation permit operation');
    return value;
  }
  private receipt(row: Record<string, any>): InputReclamationPermit {
    return {
      ...storageEpochReceipt(row),
      operationId: row.operation_id,
      reservationId: row.reservation_id,
      inputCid: row.input_cid,
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
        'unpin',
        this.operation(operation),
        storage,
      ),
    );
  }
  async get(operation: string) {
    const [row] = await this.db.query(
      'SELECT * FROM shorts_input_reclamation_permits WHERE operation_id=$1',
      [this.operation(operation)],
    );
    return row ? this.receipt(row) : undefined;
  }
  async issue(reservationId: string, operation = randomUUID()) {
    return (await this.issueForDispatch(reservationId, operation)).permit;
  }
  /** Only the transaction that creates the permit may dispatch its mutation. */
  async issueForDispatch(reservationId: string, operation: string) {
    this.operation(reservationId);
    this.operation(operation);
    return this.db.transaction(async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'",
      );
      const [reservation] = await db.query(
        'SELECT input_cid FROM shorts_input_reclamation_reservations WHERE operation_id=$1',
        [reservationId],
      );
      if (!reservation)
        throw new NotFoundException('Input reclamation reservation missing');
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||$1,0))",
        [reservation.input_cid],
      );
      const rows = await db.query(
        'SELECT * FROM shorts_input_reclamation_permits WHERE operation_id=$1 OR reservation_id=$2',
        [operation, reservationId],
      );
      if (rows.length) {
        if (
          rows.length !== 1 ||
          rows[0].operation_id !== operation ||
          rows[0].reservation_id !== reservationId
        )
          throw new ConflictException('Reclamation permit was already issued');
        return { permit: this.receipt(rows[0]), created: false };
      }
      const [row] = await db.query(
        `INSERT INTO shorts_input_reclamation_permits(operation_id,reservation_id,input_cid)
        VALUES($1,$2,$3) RETURNING *`,
        [operation, reservationId, reservation.input_cid],
      );
      return { permit: this.receipt(row), created: true };
    });
  }
  async finish(operation: string, state: ReclamationOutcome) {
    this.operation(operation);
    if (!['removed', 'not-pinned', 'rejected', 'uncertain'].includes(state))
      throw new Error('Invalid reclamation outcome');
    return this.db.transaction(async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'",
      );
      const [saved] = await db.query(
        'SELECT input_cid FROM shorts_input_reclamation_permits WHERE operation_id=$1',
        [operation],
      );
      if (!saved) throw new NotFoundException('Reclamation permit missing');
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||$1,0))",
        [saved.input_cid],
      );
      const [row] = await db.query(
        'SELECT * FROM shorts_input_reclamation_permits WHERE operation_id=$1',
        [operation],
      );
      if (row.state === state) return this.receipt(row);
      if (row.state !== 'issued')
        throw new ConflictException('Reclamation permit is already settled');
      await db.query(
        'UPDATE shorts_input_reclamation_permits SET state=$2 WHERE operation_id=$1',
        [operation, state],
      );
      const [updated] = await db.query(
        'SELECT * FROM shorts_input_reclamation_permits WHERE operation_id=$1',
        [operation],
      );
      return this.receipt(updated);
    });
  }
}

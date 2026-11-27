import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ShortsDatabaseService } from './shorts-database.service';

export interface ReclamationRoot {
  network: string;
  contract: string;
  shortId: string;
  jobId: string;
  sourceKey: string;
}
export interface InputReclamationReservation {
  operationId: string;
  inputCid: string;
  state: 'reserved' | 'invalidated' | 'released';
  roots: ReclamationRoot[];
  reservedAt: string;
  invalidatedAt: string | null;
  releasedAt: string | null;
}

/** Global reference barrier only. Never use this receipt as an IPFS delete permit. */
@Injectable()
export class ShortsInputReclamationReservationsService {
  constructor(@Inject(ShortsDatabaseService) private readonly db: DataSource) {}
  private operation(id: string) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        id,
      )
    )
      throw new Error('Invalid input reclamation operation');
    return id;
  }
  private cid(value: string) {
    if (!/^b[a-z2-7]{20,118}$/.test(value))
      throw new Error('Invalid input reclamation CID');
    return value;
  }
  private receipt(row: Record<string, any>): InputReclamationReservation {
    return {
      operationId: row.operation_id,
      inputCid: row.input_cid,
      state: row.state,
      roots: row.roots,
      reservedAt: new Date(row.reserved_at).toISOString(),
      invalidatedAt: row.invalidated_at
        ? new Date(row.invalidated_at).toISOString()
        : null,
      releasedAt: row.released_at
        ? new Date(row.released_at).toISOString()
        : null,
    };
  }
  async get(operation: string) {
    const [row] = await this.db.query(
      'SELECT * FROM shorts_input_reclamation_reservations WHERE operation_id=$1',
      [this.operation(operation)],
    );
    return row ? this.receipt(row) : undefined;
  }
  async reserve(cid: string, operation: string) {
    this.cid(cid);
    this.operation(operation);
    return this.db.transaction(async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'",
      );
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||$1,0))",
        [cid],
      );
      const [saved] = await db.query(
        'SELECT * FROM shorts_input_reclamation_reservations WHERE operation_id=$1',
        [operation],
      );
      if (saved) {
        if (saved.input_cid !== cid)
          throw new ConflictException('Reclamation operation was already used');
        return this.receipt(saved);
      }
      const [active] = await db.query(
        "SELECT operation_id FROM shorts_input_reclamation_reservations WHERE input_cid=$1 AND state<>'released'",
        [cid],
      );
      if (active)
        throw new ConflictException('Input reclamation already reserved');
      const [row] = await db.query(
        `INSERT INTO shorts_input_reclamation_reservations(operation_id,input_cid,roots)
        VALUES($1,$2,'[]') RETURNING *`,
        [operation, cid],
      );
      return this.receipt(row);
    });
  }
  /** Fresh policy check under the same reference lock; no network IO or deletion. */
  async verify(operation: string, recovering = false) {
    const saved = await this.get(operation);
    if (!saved)
      throw new NotFoundException('Input reclamation reservation missing');
    return this.db.transaction(async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'",
      );
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||$1,0))",
        [saved.inputCid],
      );
      const [row] = await db.query(
        'SELECT * FROM shorts_input_reclamation_reservations WHERE operation_id=$1',
        [operation],
      );
      if (
        row?.state !== 'reserved' &&
        !(recovering && row?.state === 'invalidated')
      )
        throw new ConflictException(
          'Input reclamation reservation is not valid',
        );
      const [{ matches }] = await db.query(
        'SELECT shorts_input_reclamation_roots($1)=$2::jsonb AS matches',
        [saved.inputCid, JSON.stringify(row.roots)],
      );
      if (!matches) throw new ConflictException('Input references changed');
      return this.receipt(row);
    });
  }
  /** Release coordination only; the database retains issued/uncertain permits and their quiet periods. */
  async cancel(operation: string) {
    const saved = await this.get(operation);
    if (!saved)
      throw new NotFoundException('Input reclamation reservation missing');
    return this.db.transaction(async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'",
      );
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||$1,0))",
        [saved.inputCid],
      );
      await db.query(
        "UPDATE shorts_input_reclamation_reservations SET state='released' WHERE operation_id=$1 AND state<>'released'",
        [operation],
      );
      const [row] = await db.query(
        'SELECT * FROM shorts_input_reclamation_reservations WHERE operation_id=$1',
        [operation],
      );
      return this.receipt(row);
    });
  }
}

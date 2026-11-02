import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ShortsDatabaseService } from './shorts-database.service';
import type { ReclamationStorage } from './shorts-reclamation-storage';

export type StorageRecoveryKind = 'pin' | 'unpin';

/** Separate immutable observations; never replace a storage write's original receipt. */
@Injectable()
export class ShortsStorageRecoveriesService {
  constructor(@Inject(ShortsDatabaseService) private readonly db: DataSource) {}
  private table(kind: StorageRecoveryKind) {
    if (kind === 'pin') return 'shorts_pin_transfers';
    if (kind === 'unpin') return 'shorts_input_reclamation_permits';
    throw new Error('Invalid storage recovery kind');
  }
  async get(kind: StorageRecoveryKind, operation: string) {
    this.table(kind);
    const [row] = await this.db.query(
      'SELECT * FROM shorts_storage_recoveries WHERE kind=$1 AND operation_id=$2',
      [kind, operation],
    );
    return row;
  }
  async commit(
    kind: StorageRecoveryKind,
    operation: string,
    storage: ReclamationStorage,
    pinned: boolean,
  ) {
    const table = this.table(kind);
    return this.db.transaction(async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'",
      );
      const [authority] = await db.query(
        `SELECT * FROM ${table} WHERE operation_id=$1`,
        [operation],
      );
      if (!authority) throw new NotFoundException('Storage authority missing');
      const cid = kind === 'pin' ? authority.cid : authority.input_cid;
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||$1,0))",
        [cid],
      );
      const [saved] = await db.query(
        'SELECT * FROM shorts_storage_recoveries WHERE kind=$1 AND operation_id=$2',
        [kind, operation],
      );
      if (saved) return saved;
      const [current] = await db.query(
        `SELECT * FROM ${table} WHERE operation_id=$1`,
        [operation],
      );
      const [receipt] = await db.query(
        `INSERT INTO shorts_storage_recoveries
        (kind,operation_id,cid,prior_state,previous_node_epoch,node_peer_id,node_epoch,observed_at,observed_pin,clock_guard_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          kind,
          operation,
          cid,
          current.state,
          current.node_epoch,
          storage.peerId,
          storage.nodeEpoch,
          new Date(storage.serverTimeUnixMs),
          pinned,
          storage.clockGuardVersion,
        ],
      );
      if (kind === 'unpin')
        await db.query(
          "UPDATE shorts_input_reclamation_reservations SET state='released' WHERE operation_id=$1",
          [current.reservation_id],
        );
      return receipt;
    });
  }
}

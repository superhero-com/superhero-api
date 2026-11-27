import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ShortsDatabaseService } from './shorts-database.service';
import type { ReclamationStorage } from './shorts-reclamation-storage';

@Injectable()
export class ShortsReclamationReleaseService {
  constructor(@Inject(ShortsDatabaseService) private readonly db: DataSource) {}
  async get(operation: string) {
    const [row] = await this.db.query(
      'SELECT * FROM shorts_input_reclamation_releases WHERE operation_id=$1',
      [operation],
    );
    return row;
  }
  async commit(
    operation: string,
    storage: ReclamationStorage,
    pinned: boolean,
  ) {
    return this.db.transaction(async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'",
      );
      const [permit] = await db.query(
        'SELECT * FROM shorts_input_reclamation_permits WHERE operation_id=$1',
        [operation],
      );
      if (!permit) throw new NotFoundException('Reclamation permit missing');
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||$1,0))",
        [permit.input_cid],
      );
      const [saved] = await db.query(
        'SELECT * FROM shorts_input_reclamation_releases WHERE operation_id=$1',
        [operation],
      );
      if (saved) return saved;
      const [receipt] = await db.query(
        `INSERT INTO shorts_input_reclamation_releases
        (operation_id,input_cid,node_peer_id,node_epoch,observed_at,observed_pin,clock_guard_version)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          operation,
          permit.input_cid,
          storage.peerId,
          storage.nodeEpoch,
          new Date(storage.serverTimeUnixMs),
          pinned,
          storage.clockGuardVersion,
        ],
      );
      await db.query(
        "UPDATE shorts_input_reclamation_reservations SET state='released' WHERE operation_id=$1",
        [permit.reservation_id],
      );
      return receipt;
    });
  }
}

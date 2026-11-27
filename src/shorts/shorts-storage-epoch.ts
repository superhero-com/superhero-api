import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface StorageWriteEpoch {
  peerId: string;
  epoch: string;
}
export function storageEpochReceipt(row: Record<string, any>) {
  return row.node_epoch
    ? {
        storage: {
          peerId: row.node_peer_id as string,
          epoch: row.node_epoch as string,
          boundAt: new Date(row.storage_bound_at).toISOString(),
        },
      }
    : {};
}

/** Shared SQL path for the two module services, using their injected database. */
export async function bindStorageEpoch(
  db: DataSource,
  kind: 'pin' | 'unpin',
  operation: string,
  storage: StorageWriteEpoch,
) {
  if (
    !storage ||
    typeof storage.peerId !== 'string' ||
    typeof storage.epoch !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,120}$/.test(storage.peerId) ||
    !/^[a-f0-9]{64}$/.test(storage.epoch)
  )
    throw new Error('Invalid storage epoch');
  const table =
    kind === 'pin'
      ? 'shorts_pin_transfers'
      : 'shorts_input_reclamation_permits';
  const cid = kind === 'pin' ? 'cid' : 'input_cid';
  return db.transaction(async (sql) => {
    await sql.query(
      "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'",
    );
    const [saved] = await sql.query(
      `SELECT ${cid} AS cid FROM ${table} WHERE operation_id=$1`,
      [operation],
    );
    if (!saved) throw new NotFoundException('Storage authority missing');
    await sql.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||$1,0))",
      [saved.cid],
    );
    const [row] = await sql.query(
      `SELECT * FROM ${table} WHERE operation_id=$1`,
      [operation],
    );
    if (row.node_epoch) {
      if (
        row.node_epoch !== storage.epoch ||
        row.node_peer_id !== storage.peerId
      )
        throw new ConflictException(
          'Storage authority is bound to another process',
        );
      return row;
    }
    if (row.state !== 'issued')
      throw new ConflictException('Storage authority is already settled');
    await sql.query(
      `UPDATE ${table} SET node_peer_id=$2,node_epoch=$3 WHERE operation_id=$1`,
      [operation, storage.peerId, storage.epoch],
    );
    const [bound] = await sql.query(
      `SELECT * FROM ${table} WHERE operation_id=$1`,
      [operation],
    );
    return bound;
  });
}

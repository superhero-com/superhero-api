import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

export interface ProjectionScope {
  network: string;
  contract: string;
  generation: string;
}
export interface GraphMutation {
  from: string;
  to: string;
  kind: 'follow' | 'block';
  present: boolean;
}
export interface GraphEventIdentity {
  transaction: string;
  index: number;
  height: string;
}

/** All mutations serialize within a projection generation; no degree-dependent recount. */
@Injectable()
export class SocialGraphProjectionService {
  constructor(private readonly db: DataSource) {}

  async applyEvent(
    scope: ProjectionScope,
    event: GraphEventIdentity,
    changes: GraphMutation[],
  ): Promise<boolean> {
    if (changes.length > 100) throw new Error('Projection batch exceeds bound');
    return this.db.transaction(async (m) => {
      const args = [scope.network, scope.contract, scope.generation];
      const rows = await m.query(
        'SELECT state,snapshot_height FROM social_graph_projection_scopes WHERE network=$1 AND contract=$2 AND generation=$3 FOR UPDATE',
        args,
      );
      if (
        rows.length !== 1 ||
        !['ready', 'catching-up'].includes(rows[0].state)
      )
        throw new Error('Projection is not ready for events');
      if (
        rows[0].snapshot_height != null &&
        BigInt(event.height) < BigInt(rows[0].snapshot_height)
      )
        return false;
      const inserted = await m.query(
        `INSERT INTO social_graph_projection_events(network,contract,generation,tx_hash,event_index,height)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING tx_hash`,
        [...args, event.transaction, event.index, event.height],
      );
      if (!inserted.length) return false;
      for (const change of changes) await this.mutate(m, scope, change);
      return true;
    });
  }

  // Caller must own the scope row lock. Snapshot imports use this same primitive,
  // without events or notification emission, and commit cursor in the transaction.
  async mutate(
    m: EntityManager,
    scope: ProjectionScope,
    edge: GraphMutation,
  ): Promise<boolean> {
    const args = [
      scope.network,
      scope.contract,
      scope.generation,
      edge.from,
      edge.to,
      edge.kind,
    ];
    const rows = edge.present
      ? await m.query(
          `INSERT INTO social_graph_projection_edges(network,contract,generation,from_address,to_address,kind)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
          args,
        )
      : await m.query(
          `WITH removed AS (DELETE FROM social_graph_projection_edges WHERE network=$1 AND contract=$2 AND generation=$3
        AND from_address=$4 AND to_address=$5 AND kind=$6 RETURNING id) SELECT id FROM removed`,
          args,
        );
    if (!rows.length) return false;
    const delta = edge.present ? 1 : -1;
    // Deterministic order avoids address-order deadlocks with other writers.
    for (const address of [...new Set([edge.from, edge.to])].sort()) {
      const key = [scope.network, scope.contract, scope.generation, address];
      await m.query(
        `INSERT INTO social_graph_projection_counts(network,contract,generation,address)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        key,
      );
      await m.query(
        `UPDATE social_graph_projection_counts SET followers=followers+$5,following=following+$6,blocked=blocked+$7
        WHERE network=$1 AND contract=$2 AND generation=$3 AND address=$4`,
        [
          ...key,
          edge.kind === 'follow' && address === edge.to ? delta : 0,
          edge.kind === 'follow' && address === edge.from ? delta : 0,
          edge.kind === 'block' && address === edge.from ? delta : 0,
        ],
      );
      await m.query(
        `INSERT INTO social_graph_projection_dirty(network,contract,generation,address) VALUES($1,$2,$3,$4)
        ON CONFLICT(network,contract,generation,address) DO UPDATE SET revision=social_graph_projection_dirty.revision+1`,
        key,
      );
    }
    return true;
  }

  async pending(
    scope: ProjectionScope,
    limit = 100,
  ): Promise<{ address: string; revision: string }[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Invalid reconciliation limit');
    return this.db.query(
      `SELECT address,revision::text FROM social_graph_projection_dirty
      WHERE network=$1 AND contract=$2 AND generation=$3 ORDER BY address LIMIT $4`,
      [scope.network, scope.contract, scope.generation, limit],
    );
  }

  async acknowledge(
    scope: ProjectionScope,
    address: string,
    revision: string,
  ): Promise<void> {
    // Never erase activity committed while the chain read was in flight.
    await this.db.query(
      `DELETE FROM social_graph_projection_dirty WHERE network=$1 AND contract=$2 AND generation=$3
      AND address=$4 AND revision=$5`,
      [scope.network, scope.contract, scope.generation, address, revision],
    );
  }

  async invalidateAfterReorg(scope: ProjectionScope): Promise<void> {
    // Deletions cannot be reversed from edge rows. Fail closed and rebuild a new
    // generation at a canonical snapshot, then replay; never resurrect legacy rows.
    await this.db.query(
      `UPDATE social_graph_projection_scopes SET state='rebuilding'
      WHERE network=$1 AND contract=$2 AND generation=$3`,
      [scope.network, scope.contract, scope.generation],
    );
  }
}

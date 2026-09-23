import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SocialGraphReader } from './social-graph-reader';
import {
  ProjectionScope,
  SocialGraphProjectionService,
} from './social-graph-projection.service';

type Reader = Pick<
  SocialGraphReader,
  'identity' | 'countsAt' | 'assertCanonical'
>;

@Injectable()
export class SocialGraphReconcileService {
  constructor(
    private readonly db: DataSource,
    private readonly projection: SocialGraphProjectionService,
  ) {}

  async step(
    scope: ProjectionScope,
    reader: Reader,
    limit = 100,
  ): Promise<number> {
    if (
      scope.network !== reader.identity.network ||
      scope.contract !== reader.identity.contract
    )
      throw new Error('Reconciliation scope mismatch');
    const key = [scope.network, scope.contract, scope.generation];
    const s = (
      await this.db.query(
        'SELECT * FROM social_graph_projection_scopes WHERE network=$1 AND contract=$2 AND generation=$3',
        key,
      )
    )[0];
    if (
      !s ||
      s.state !== 'ready' ||
      !s.synced_hash ||
      s.synced_height == null ||
      s.sync_end_height != null
    )
      return 0;
    // Compare against the projection watermark, never the moving chain tip.
    await reader.assertCanonical(s.synced_hash, s.synced_height);
    const pending = await this.projection.pending(scope, limit);
    let checked = 0;
    for (const dirty of pending) {
      const actual = await reader.countsAt(dirty.address, s.synced_hash);
      await reader.assertCanonical(s.synced_hash, s.synced_height);
      const result = await this.db.transaction(async (m) => {
        const current = (
          await m.query(
            'SELECT state,synced_hash,sync_end_height FROM social_graph_projection_scopes WHERE network=$1 AND contract=$2 AND generation=$3 FOR UPDATE',
            key,
          )
        )[0];
        if (
          !current ||
          current.state !== 'ready' ||
          current.sync_end_height != null ||
          current.synced_hash !== s.synced_hash
        )
          return 'changed';
        const revision = (
          await m.query(
            'SELECT revision::text FROM social_graph_projection_dirty WHERE network=$1 AND contract=$2 AND generation=$3 AND address=$4',
            [...key, dirty.address],
          )
        )[0];
        if (!revision || revision.revision !== dirty.revision) return 'changed';
        const count = (
          await m.query(
            'SELECT followers::text,following::text,blocked::text FROM social_graph_projection_counts WHERE network=$1 AND contract=$2 AND generation=$3 AND address=$4',
            [...key, dirty.address],
          )
        )[0] ?? { followers: '0', following: '0', blocked: '0' };
        if (
          ['followers', 'following', 'blocked'].some(
            (k) => count[k] !== actual[k],
          )
        ) {
          await m.query(
            "UPDATE social_graph_projection_scopes SET state='rebuilding' WHERE network=$1 AND contract=$2 AND generation=$3",
            key,
          );
          return 'drift';
        }
        await m.query(
          'DELETE FROM social_graph_projection_dirty WHERE network=$1 AND contract=$2 AND generation=$3 AND address=$4 AND revision=$5',
          [...key, dirty.address, dirty.revision],
        );
        return 'checked';
      });
      if (result === 'drift')
        throw new Error('Social graph count drift; projection invalidated');
      if (result === 'changed') break;
      checked++;
    }
    return checked;
  }
}

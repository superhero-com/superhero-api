import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ProjectionScope,
  SocialGraphV2ProjectionService,
} from './social-graph-v2-projection.service';
import {
  SocialGraphV2Reader,
  decimal,
  encodeGraphCursor,
  decodeGraphCursor,
} from './social-graph-v2-reader';

type SnapshotReader = Pick<
  SocialGraphV2Reader,
  'identity' | 'policy' | 'page' | 'assertCanonical' | 'migrationEvidence'
>;

@Injectable()
export class SocialGraphV2SnapshotService {
  constructor(
    private readonly db: DataSource,
    private readonly projection: SocialGraphV2ProjectionService,
  ) {}

  private match(scope: ProjectionScope, reader: SnapshotReader) {
    if (
      scope.contract !== reader.identity.contract ||
      scope.network !== reader.identity.network
    )
      throw new Error('Snapshot scope mismatch');
    decimal(scope.generation);
  }

  async begin(scope: ProjectionScope, reader: SnapshotReader): Promise<void> {
    this.match(scope, reader);
    const policy = await reader.policy();
    if (policy.importing) throw new Error('Destination import is not complete');
    const evidence =
      policy.import_source || policy.legacy_source
        ? await reader.migrationEvidence(policy)
        : { sourceCutoff: null, activationHeight: null, proof: null };
    await reader.assertCanonical(policy.block_hash, policy.height);
    // Never reset an existing checkpoint. A restart must continue it or choose
    // a new generation after invalidation, keeping the old projection isolated.
    await this.db.query(
      `INSERT INTO social_graph_v2_scopes
      (network,contract,generation,state,snapshot_hash,snapshot_height,source_contract,source_cutoff,activation_height,migration_evidence)
      VALUES($1,$2,$3,'importing',$4,$5,$6,$7,$8,$9)`,
      [
        scope.network,
        scope.contract,
        scope.generation,
        policy.block_hash,
        policy.height,
        policy.import_source || policy.legacy_source || null,
        evidence.sourceCutoff,
        evidence.activationHeight,
        evidence.proof,
      ],
    );
  }

  async step(scope: ProjectionScope, reader: SnapshotReader): Promise<boolean> {
    this.match(scope, reader);
    const key = [scope.network, scope.contract, scope.generation];
    const rows = await this.db.query(
      'SELECT * FROM social_graph_v2_scopes WHERE network=$1 AND contract=$2 AND generation=$3',
      key,
    );
    const state = rows[0];
    if (!state || state.state !== 'importing')
      throw new Error('No resumable snapshot');
    await reader.assertCanonical(state.snapshot_hash, state.snapshot_height);
    const token = encodeGraphCursor({
      ...reader.identity,
      version: 2,
      direction: 'export',
      account: '',
      top: state.snapshot_hash,
      offset: String(state.export_cursor),
    });
    const page = await reader.page('export', '', 100, token);
    if (
      page.block_hash !== state.snapshot_hash ||
      page.network !== scope.network ||
      page.contract !== scope.contract
    )
      throw new Error('Snapshot page identity changed');
    const next = page.next_cursor
      ? decodeGraphCursor(page.next_cursor, {
          ...reader.identity,
          direction: 'export',
          account: '',
        }).offset
      : decimal(page.end_cursor);
    if (
      BigInt(next) < BigInt(state.export_cursor) ||
      BigInt(next) > BigInt(state.export_cursor) + 100n ||
      (page.next_cursor && next === String(state.export_cursor)) ||
      page.items.length > 100
    )
      throw new Error('Invalid snapshot progress');
    await reader.assertCanonical(state.snapshot_hash, state.snapshot_height);
    return this.db.transaction(async (m) => {
      const current = (
        await m.query(
          'SELECT * FROM social_graph_v2_scopes WHERE network=$1 AND contract=$2 AND generation=$3 FOR UPDATE',
          key,
        )
      )[0];
      if (
        current.state !== 'importing' ||
        String(current.export_cursor) !== String(state.export_cursor)
      )
        throw new Error('Snapshot checkpoint changed');
      for (const item of page.items) {
        const variants = Object.keys(item);
        if (
          variants.length !== 1 ||
          !['Follow', 'Block', 'Rate'].includes(variants[0])
        )
          throw new Error('Invalid snapshot record');
        const kind = variants[0],
          pair = item[kind];
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          !/^ak_[1-9A-HJ-NP-Za-km-z]+$/.test(pair[0])
        )
          throw new Error('Invalid snapshot account');
        if (kind === 'Rate') {
          await m.query(
            `INSERT INTO social_graph_v2_rates(network,contract,generation,address,last_follow_height)
            VALUES($1,$2,$3,$4,$5)`,
            [...key, pair[0], decimal(pair[1])],
          );
        } else {
          if (
            !/^ak_[1-9A-HJ-NP-Za-km-z]+$/.test(pair[1]) ||
            pair[0] === pair[1]
          )
            throw new Error('Invalid snapshot edge');
          await this.projection.mutate(m, scope, {
            from: pair[0],
            to: pair[1],
            kind: kind === 'Follow' ? 'follow' : 'block',
            present: true,
          });
        }
      }
      await m.query(
        `UPDATE social_graph_v2_scopes SET export_cursor=$4,state=$5
        WHERE network=$1 AND contract=$2 AND generation=$3`,
        [...key, next, page.next_cursor ? 'importing' : 'catching-up'],
      );
      return !page.next_cursor;
    });
  }
}

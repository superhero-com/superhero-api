import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProjectionScope } from './social-graph-projection.service';
import { decimal } from './social-graph-reader';

@Injectable()
export class SocialGraphQueryService {
  constructor(private readonly db: DataSource) {}
  async ready(network: string, contract: string): Promise<ProjectionScope> {
    // The newest generation controls availability: never fall back to stale data.
    // Qualify the bigint column: the selected generation::text alias sorts lexically.
    const rows = await this.db.query(
      `SELECT generation::text,state FROM social_graph_projection_scopes
      WHERE network=$1 AND contract=$2 ORDER BY social_graph_projection_scopes.generation DESC LIMIT 1`,
      [network, contract],
    );
    if (rows[0]?.state !== 'ready')
      throw new ServiceUnavailableException(
        'Social graph projection is not ready',
      );
    return { network, contract, generation: rows[0].generation };
  }
  async status(network: string, contract: string) {
    const rows = await this.db.query(
      `SELECT generation::text,state,snapshot_height::text,synced_height::text AS completed_height,synced_hash AS completed_hash,
      sync_last_height::text AS pending_height,sync_last_position::text AS pending_position,(sync_end_height IS NOT NULL) AS catching_up,
      source_contract,source_cutoff::text,activation_height::text,migration_evidence
      FROM social_graph_projection_scopes WHERE network=$1 AND contract=$2 ORDER BY social_graph_projection_scopes.generation DESC LIMIT 1`,
      [network, contract],
    );
    return {
      network,
      contract,
      ...(rows[0] ?? {
        generation: null,
        state: 'uninitialized',
        snapshot_height: null,
        completed_height: null,
        completed_hash: null,
        pending_height: null,
        pending_position: null,
        catching_up: false,
        source_contract: null,
        source_cutoff: null,
        activation_height: null,
        migration_evidence: null,
      }),
    };
  }

  private account(address: string) {
    if (!/^ak_[1-9A-HJ-NP-Za-km-z]+$/.test(address))
      throw new BadRequestException('Invalid account');
  }
  async counts(scope: ProjectionScope, address: string) {
    this.account(address);
    const rows = await this.db.query(
      `SELECT COALESCE(c.followers,0)::text AS followers,
      COALESCE(c.following,0)::text AS following,COALESCE(c.blocked,0)::text AS blocked,
      s.synced_height::text AS completed_height,s.synced_hash AS completed_hash,s.sync_last_height::text AS pending_height,
      s.sync_last_position::text AS pending_position,(s.sync_end_height IS NOT NULL) AS catching_up
      FROM social_graph_projection_scopes s LEFT JOIN social_graph_projection_counts c
      ON c.network=s.network AND c.contract=s.contract AND c.generation=s.generation AND c.address=$4
      WHERE s.network=$1 AND s.contract=$2 AND s.generation=$3 AND s.state='ready' AND NOT EXISTS(SELECT 1 FROM social_graph_projection_scopes newer WHERE newer.network=s.network AND newer.contract=s.contract AND newer.generation>s.generation)`,
      [scope.network, scope.contract, scope.generation, address],
    );
    if (!rows.length)
      throw new ServiceUnavailableException(
        'Social graph projection is not ready',
      );
    return { ...scope, address, ...rows[0] };
  }
  async connections(
    scope: ProjectionScope,
    address: string,
    direction: 'followers' | 'following',
    limit: number,
    token?: string,
    search?: string,
  ) {
    this.account(address);
    if (
      !['followers', 'following'].includes(direction) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new BadRequestException('Invalid page request');
    if (search != null && (typeof search !== 'string' || search.length > 100))
      throw new BadRequestException('Search must be at most 100 characters');
    const normalizedSearch = search?.trim() ?? '';
    let before: string | undefined;
    if (token) {
      try {
        if (token.length > 2048) throw new Error();
        const c = JSON.parse(Buffer.from(token, 'base64url').toString());
        if (
          c.network !== scope.network ||
          c.contract !== scope.contract ||
          c.generation !== scope.generation ||
          c.account !== address ||
          c.direction !== direction ||
          (c.search ?? '') !== normalizedSearch
        )
          throw new Error();
        before = decimal(c.before);
        if (BigInt(before) > 9223372036854775807n) throw new Error();
      } catch {
        throw new BadRequestException('Invalid projection cursor');
      }
    }
    return this.db.transaction('REPEATABLE READ', async (m) => {
      const state = await m.query(
        'SELECT state,synced_height::text AS completed_height,synced_hash AS completed_hash,sync_last_height::text AS pending_height,sync_last_position::text AS pending_position,(sync_end_height IS NOT NULL) AS catching_up FROM social_graph_projection_scopes s WHERE network=$1 AND contract=$2 AND generation=$3 AND NOT EXISTS(SELECT 1 FROM social_graph_projection_scopes newer WHERE newer.network=s.network AND newer.contract=s.contract AND newer.generation>s.generation)',
        [scope.network, scope.contract, scope.generation],
      );
      if (state[0]?.state !== 'ready')
        throw new ServiceUnavailableException(
          'Social graph projection is not ready',
        );
      const owner = direction === 'followers' ? 'to_address' : 'from_address';
      const other = direction === 'followers' ? 'from_address' : 'to_address';
      const rows = await m.query(
        `SELECT id::text,${other} AS address FROM social_graph_projection_edges
        WHERE network=$1 AND contract=$2 AND generation=$3 AND ${owner}=$4 AND kind='follow'
        ${before ? 'AND id<$6' : ''} ORDER BY social_graph_projection_edges.id DESC LIMIT $5`,
        [
          scope.network,
          scope.contract,
          scope.generation,
          address,
          limit + 1,
          ...(before ? [before] : []),
        ],
      );
      const more = rows.length > limit,
        items = rows.slice(0, limit);
      // Search only the bounded edge page. Empty search results still carry
      // its continuation, avoiding unbounded scans over a celebrity's followers.
      let addresses: string[] = items.map((r) => r.address);
      if (normalizedSearch && addresses.length) {
        const matches = await m.query(
          `SELECT candidate.address FROM unnest($1::text[]) candidate(address)
          LEFT JOIN accounts a ON a.address=candidate.address
          LEFT JOIN profile_cache p ON p.address=candidate.address
          WHERE candidate.address ILIKE $2 OR a.chain_name ILIKE $2
          OR p.public_name ILIKE $2 OR p.username ILIKE $2 OR p.fullname ILIKE $2`,
          [addresses, `%${normalizedSearch}%`],
        );
        const allowed = new Set(matches.map((row) => row.address));
        addresses = addresses.filter((item) => allowed.has(item));
      }
      return {
        ...scope,
        account: address,
        completed_height: state[0].completed_height,
        completed_hash: state[0].completed_hash,
        pending_height: state[0].pending_height,
        pending_position: state[0].pending_position,
        catching_up: state[0].catching_up,
        addresses,
        next_cursor: more
          ? Buffer.from(
              JSON.stringify({
                ...scope,
                account: address,
                direction,
                search: normalizedSearch,
                before: items[items.length - 1].id,
              }),
            ).toString('base64url')
          : null,
      };
    });
  }
}

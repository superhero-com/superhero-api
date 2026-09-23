import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProjectionScope } from './social-graph-v2-projection.service';
import { decimal } from './social-graph-v2-reader';

@Injectable()
export class SocialGraphV2QueryService {
  constructor(private readonly db: DataSource) {}
  async ready(network: string, contract: string): Promise<ProjectionScope> {
    // The newest generation controls availability: never fall back to stale data.
    const rows = await this.db.query(
      `SELECT generation::text,state FROM social_graph_v2_scopes
      WHERE network=$1 AND contract=$2 ORDER BY generation DESC LIMIT 1`,
      [network, contract],
    );
    if (rows[0]?.state !== 'ready')
      throw new ServiceUnavailableException('V2 graph projection is not ready');
    return { network, contract, generation: rows[0].generation };
  }
  private account(address: string) {
    if (!/^ak_[1-9A-HJ-NP-Za-km-z]+$/.test(address))
      throw new BadRequestException('Invalid account');
  }
  async counts(scope: ProjectionScope, address: string) {
    this.account(address);
    const rows = await this.db.query(
      `SELECT COALESCE(c.followers,0)::text AS followers,
      COALESCE(c.following,0)::text AS following,COALESCE(c.blocked,0)::text AS blocked
      FROM social_graph_v2_scopes s LEFT JOIN social_graph_v2_counts c
      ON c.network=s.network AND c.contract=s.contract AND c.generation=s.generation AND c.address=$4
      WHERE s.network=$1 AND s.contract=$2 AND s.generation=$3 AND s.state='ready' AND NOT EXISTS(SELECT 1 FROM social_graph_v2_scopes newer WHERE newer.network=s.network AND newer.contract=s.contract AND newer.generation>s.generation)`,
      [scope.network, scope.contract, scope.generation, address],
    );
    if (!rows.length)
      throw new ServiceUnavailableException('V2 graph projection is not ready');
    return { ...scope, address, ...rows[0] };
  }
  async connections(
    scope: ProjectionScope,
    address: string,
    direction: 'followers' | 'following',
    limit: number,
    token?: string,
  ) {
    this.account(address);
    if (
      !['followers', 'following'].includes(direction) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new BadRequestException('Invalid page request');
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
          c.direction !== direction
        )
          throw new Error();
        before = decimal(c.before);
      } catch {
        throw new BadRequestException('Invalid projection cursor');
      }
    }
    return this.db.transaction('REPEATABLE READ', async (m) => {
      const state = await m.query(
        'SELECT state FROM social_graph_v2_scopes s WHERE network=$1 AND contract=$2 AND generation=$3 AND NOT EXISTS(SELECT 1 FROM social_graph_v2_scopes newer WHERE newer.network=s.network AND newer.contract=s.contract AND newer.generation>s.generation)',
        [scope.network, scope.contract, scope.generation],
      );
      if (state[0]?.state !== 'ready')
        throw new ServiceUnavailableException(
          'V2 graph projection is not ready',
        );
      const owner = direction === 'followers' ? 'to_address' : 'from_address';
      const other = direction === 'followers' ? 'from_address' : 'to_address';
      const rows = await m.query(
        `SELECT id::text,${other} AS address FROM social_graph_v2_edges
        WHERE network=$1 AND contract=$2 AND generation=$3 AND ${owner}=$4 AND kind='follow'
        ${before ? 'AND id<$6' : ''} ORDER BY social_graph_v2_edges.id DESC LIMIT $5`,
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
      return {
        ...scope,
        account: address,
        addresses: items.map((r) => r.address),
        next_cursor: more
          ? Buffer.from(
              JSON.stringify({
                ...scope,
                account: address,
                direction,
                before: items[items.length - 1].id,
              }),
            ).toString('base64url')
          : null,
      };
    });
  }
}

import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Encoded, Encoding, isAddressValid } from '@aeternity/aepp-sdk';
import { DataSource, EntityManager } from 'typeorm';
import { createHash } from 'node:crypto';
import { SocialGraphReader } from '../plugins/social-graph/social-graph-reader';
import type { ProjectionScope } from '../plugins/social-graph/social-graph-projection.service';
import { ShortsDatabaseService } from './shorts-database.service';
import { ShortsChainService } from './shorts-chain.service';
import { catalogCursor, CATALOG_PAGE_SIZE } from './shorts-catalog';
import type { ShortsScope } from './shorts-metadata.service';

/** Public candidate reads from the existing social-graph projection; never a second follow store. */
@Injectable()
export class ShortsFollowingService {
  private reader?: SocialGraphReader;
  constructor(
    @Inject(ShortsDatabaseService) private readonly db: DataSource,
    private readonly chain: ShortsChainService,
  ) {}

  private async identity(network: string) {
    if (!this.reader) {
      const contract = process.env.SOCIAL_GRAPH_CONTRACT_ADDRESS;
      if (
        process.env.SOCIAL_GRAPH_NETWORK_ID !== network ||
        !contract ||
        !isAddressValid(contract, Encoding.ContractAddress)
      )
        throw new ServiceUnavailableException(
          'Following is not configured for this network',
        );
      this.reader = new SocialGraphReader(this.chain.sdk.getContext().onNode, {
        network,
        contract: contract as Encoded.ContractAddress,
      });
    }
    if (this.reader.identity.network !== network)
      throw new ServiceUnavailableException('Following network changed');
    // Reuse the social plugin's exact bytecode/network verifier with Shorts' bounded transport.
    await this.chain.readNode(() => this.reader!.verifyIdentity());
    return this.reader.identity;
  }

  private async ready(
    db: EntityManager,
    network: string,
    contract: string,
    expected?: string,
  ) {
    const [row] = await db.query(
      `SELECT generation::text,state FROM social_graph_projection_scopes
       WHERE network=$1 AND contract=$2
       ORDER BY social_graph_projection_scopes.generation DESC LIMIT 1`,
      [network, contract],
    );
    if (
      row?.state !== 'ready' ||
      (expected !== undefined && row.generation !== expected)
    )
      throw new ServiceUnavailableException(
        'Following is updating. Refresh the feed shortly.',
      );
    return { network, contract, generation: String(row.generation) };
  }

  private eligible = `f.network=$1 AND f.contract=$2 AND f.generation=$3
    AND f.from_address=$4 AND f.kind='follow' AND f.to_address<>$4
    AND NOT EXISTS(SELECT 1 FROM social_graph_projection_edges b
      WHERE b.network=f.network AND b.contract=f.contract AND b.generation=f.generation
      AND b.kind='block' AND b.from_address=$4 AND b.to_address=f.to_address)
    AND NOT EXISTS(SELECT 1 FROM social_graph_projection_edges b
      WHERE b.network=f.network AND b.contract=f.contract AND b.generation=f.generation
      AND b.kind='block' AND b.to_address=$4 AND b.from_address=f.to_address)`;

  private async revision(
    db: EntityManager,
    graph: ProjectionScope,
    actor: string,
  ) {
    // The plugin serializes mutations on the generation's scope lock, so committed
    // edge IDs are monotonic within a generation: an insertion changes
    // the maximum; a removal changes the count. Dirty rows are acknowledged/deleted
    // by reconciliation, so they cannot serve as a persistent membership version.
    const [row] = await db.query(
      `SELECT count(*)::text AS count,COALESCE(max(id),0)::text AS last
       FROM social_graph_projection_edges
       WHERE network=$1 AND contract=$2 AND generation=$3
       AND (from_address=$4 OR (to_address=$4 AND kind='block'))`,
      [graph.network, graph.contract, graph.generation, actor],
    );
    return createHash('sha256')
      .update(JSON.stringify([graph, actor, row.count, row.last]))
      .digest('hex');
  }

  async page(
    scope: ShortsScope,
    sourceHash: string,
    actor: string,
    cursor?: string,
  ): Promise<{
    graph: ProjectionScope;
    revision: string;
    ids: string[];
    next: string | null;
  }> {
    const identity = await this.identity(scope.network);
    return this.db.transaction('REPEATABLE READ', async (db) => {
      const graph = await this.ready(db, identity.network, identity.contract);
      const revision = await this.revision(db, graph, actor);
      const paging = catalogCursor(
        [
          scope.network,
          scope.contract,
          sourceHash,
          'following',
          actor,
          revision,
        ],
        cursor,
      );
      // Each creator contributes at most one page. The partial creator index avoids
      // scanning unrelated uploads or private drafts to find older followed videos.
      const rows = await db.query(
        `SELECT c.id,c.created_at FROM social_graph_projection_edges f
        CROSS JOIN LATERAL (
          SELECT id,created_at FROM shorts_content
          WHERE network=$5 AND contract=$6 AND creator=f.to_address
          AND body->>'publication'='published' AND body->>'moderation'='approved'
          AND ($7::bigint IS NULL OR (created_at,id)<($7,$8))
          ORDER BY created_at DESC,id DESC LIMIT $9
        ) c WHERE ${this.eligible}
        ORDER BY c.created_at DESC,c.id DESC LIMIT $9`,
        [
          graph.network,
          graph.contract,
          graph.generation,
          actor,
          scope.network,
          scope.contract,
          paging.after?.at ?? null,
          paging.after?.id ?? null,
          CATALOG_PAGE_SIZE + 1,
        ],
      );
      const candidates = rows.slice(0, CATALOG_PAGE_SIZE);
      const last = candidates.at(-1);
      return {
        graph,
        revision,
        ids: candidates.map((row) => String(row.id)),
        next:
          rows.length > CATALOG_PAGE_SIZE
            ? paging.encode({
                at: Number(last.created_at),
                id: String(last.id),
              })
            : null,
      };
    });
  }

  async current(network: string): Promise<ProjectionScope> {
    const identity = await this.identity(network);
    return this.db.transaction((db) =>
      this.ready(db, identity.network, identity.contract),
    );
  }

  /** Recheck membership after slower chain/policy reads, including index-generation rollover. */
  async creators(graph: ProjectionScope, actor: string, creators: string[]) {
    if (creators.length > CATALOG_PAGE_SIZE)
      throw new Error('Following recheck exceeds page size');
    return this.db.transaction('REPEATABLE READ', async (db) => {
      await this.ready(db, graph.network, graph.contract, graph.generation);
      const revision = await this.revision(db, graph, actor);
      if (!creators.length) return { creators: new Set<string>(), revision };
      const rows = await db.query(
        `SELECT f.to_address FROM social_graph_projection_edges f
         WHERE ${this.eligible} AND f.to_address=ANY($5::text[])`,
        [graph.network, graph.contract, graph.generation, actor, creators],
      );
      return {
        creators: new Set<string>(rows.map((row) => String(row.to_address))),
        revision,
      };
    });
  }
}

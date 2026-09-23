import { MigrationInterface, QueryRunner } from 'typeorm';

export class SocialGraphProjection1718900000035 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    // Separate scoped storage leaves the old projection intact during rolling
    // upgrades and rollback. Only the canonical graph worker writes these tables.
    await q.query(`CREATE TABLE social_graph_projection_scopes (
      network text NOT NULL, contract text NOT NULL, generation bigint NOT NULL DEFAULT 1,
      state text NOT NULL DEFAULT 'importing' CHECK (state IN ('importing','catching-up','ready','rebuilding')),
      snapshot_hash text, snapshot_height bigint, export_cursor numeric(78,0) NOT NULL DEFAULT 0,
      source_contract text, source_cutoff bigint, activation_height bigint, migration_evidence jsonb,
      notify_from_height bigint, synced_hash text, synced_height bigint, sync_end_hash text, sync_end_height bigint,
      sync_cursor text, sync_last_position numeric(78,0), sync_last_height bigint,
      PRIMARY KEY(network,contract,generation))`);
    await q.query(`CREATE TABLE social_graph_projection_edges (
      id bigserial PRIMARY KEY, network text NOT NULL, contract text NOT NULL, generation bigint NOT NULL,
      from_address text NOT NULL, to_address text NOT NULL, kind text NOT NULL CHECK(kind IN ('follow','block')),
      UNIQUE(network,contract,generation,from_address,to_address,kind))`);
    await q.query(
      'CREATE INDEX social_graph_projection_followers ON social_graph_projection_edges(network,contract,generation,to_address,kind,id DESC)',
    );
    await q.query(
      'CREATE INDEX social_graph_projection_following ON social_graph_projection_edges(network,contract,generation,from_address,kind,id DESC)',
    );
    await q.query(`CREATE TABLE social_graph_projection_counts (
      network text NOT NULL, contract text NOT NULL, generation bigint NOT NULL, address text NOT NULL,
      followers bigint NOT NULL DEFAULT 0 CHECK(followers>=0), following bigint NOT NULL DEFAULT 0 CHECK(following>=0),
      blocked bigint NOT NULL DEFAULT 0 CHECK(blocked>=0), PRIMARY KEY(network,contract,generation,address))`);
    await q.query(`CREATE TABLE social_graph_projection_dirty (
      network text NOT NULL, contract text NOT NULL, generation bigint NOT NULL, address text NOT NULL,
      revision bigint NOT NULL DEFAULT 1, PRIMARY KEY(network,contract,generation,address))`);
    await q.query(`CREATE TABLE social_graph_projection_events (
      network text NOT NULL, contract text NOT NULL, generation bigint NOT NULL,
      tx_hash text NOT NULL, event_index integer NOT NULL, height bigint NOT NULL,
      PRIMARY KEY(network,contract,generation,tx_hash,event_index))`);
    await q.query(`CREATE TABLE social_graph_projection_outbox (
      network text NOT NULL, contract text NOT NULL, generation bigint NOT NULL,
      tx_hash text NOT NULL, event_index integer NOT NULL, height bigint NOT NULL,
      follower text NOT NULL, followed text NOT NULL, delivered boolean NOT NULL DEFAULT false,
      attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(network,contract,tx_hash,event_index))`);
    await q.query(
      `CREATE INDEX social_graph_projection_outbox_pending ON social_graph_projection_outbox(network,contract,generation,next_attempt_at,height,tx_hash,event_index) WHERE delivered=false`,
    );
    await q.query(`CREATE TABLE social_graph_projection_rates (
      network text NOT NULL, contract text NOT NULL, generation bigint NOT NULL, address text NOT NULL,
      last_follow_height numeric(78,0) NOT NULL,
      PRIMARY KEY(network,contract,generation,address))`);
  }
  async down(q: QueryRunner): Promise<void> {
    for (const table of [
      'outbox',
      'rates',
      'events',
      'dirty',
      'counts',
      'edges',
      'scopes',
    ]) {
      await q.query(`DROP TABLE social_graph_projection_${table}`);
    }
  }
}

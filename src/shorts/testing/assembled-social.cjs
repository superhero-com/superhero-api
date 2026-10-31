// Controlled external social-chain observations over the real SQL projection.
// No social transaction is signed. Socket invalidations use the real gateway.
const assert = require('node:assert/strict');
const { runtimeRequire } = require('./fixture-runtime.cjs');
const { randomBytes, createHash } = require('node:crypto');
const { readFile, writeFile, rename } = require('node:fs/promises');
const { join, isAbsolute } = require('node:path');
const { encode, Encoding } = require('@aeternity/aepp-sdk');

exports.socialFixture = async (db, dir) => {
  const buildPath = process.env.SHORTS_TEST_SOCIAL_BUILD;
  if (!buildPath) return undefined;
  assert.ok(isAbsolute(buildPath));
  const build = JSON.parse(await readFile(buildPath, 'utf8'));
  const expected = runtimeRequire('../../plugins/social-graph/aci/SocialContract.build.json');
  assert.equal(createHash('sha256').update(build.bytecode).digest('hex'), expected.bytecodeSha256);
  const { SocialGraphProjection1718900000035 } = runtimeRequire('../../migrations/1718900000035-SocialGraphProjection');
  await new SocialGraphProjection1718900000035().up(db);
  const graph = { network: 'ae_uat', contract: encode(randomBytes(32), Encoding.ContractAddress), generation: '1' };
  await db.query('INSERT INTO social_graph_projection_scopes(network,contract,generation,state,synced_height) VALUES($1,$2,$3,$4,100)',
    [graph.network, graph.contract, graph.generation, 'ready']);
  const state = { ...graph, bytecode: build.bytecode, edges: [] };
  const file = join(dir, 'social.json');
  const save = async () => { await writeFile(file + '.next', JSON.stringify(state), { mode: 0o600 }); await rename(file + '.next', file); };
  await save();
  const { SocialGraphProjectionService } = runtimeRequire('../../plugins/social-graph/social-graph-projection.service');
  const projection = new SocialGraphProjectionService(db);
  return {
    graph,
    env: { SHORTS_TEST_SOCIAL_STATE: file, SOCIAL_GRAPH_NETWORK_ID: graph.network, SOCIAL_GRAPH_CONTRACT_ADDRESS: graph.contract },
    async edge(from, to, kind, present) {
      await projection.applyEvent(graph, { transaction: encode(randomBytes(32), Encoding.TxHash), index: 0, height: '100' }, [{ from, to, kind, present }]);
      state.edges = state.edges.filter(edge => edge.from !== from || edge.to !== to || edge.kind !== kind);
      if (present) state.edges.push({ from, to, kind });
      await save();
    },
    async rebuilding(enabled) {
      // A newer unavailable generation must never fall back to the old ready one.
      if (enabled) await db.query('INSERT INTO social_graph_projection_scopes(network,contract,generation,state) VALUES($1,$2,2,$3)', [graph.network, graph.contract, 'rebuilding']);
      else await db.query('DELETE FROM social_graph_projection_scopes WHERE network=$1 AND contract=$2 AND generation=2', [graph.network, graph.contract]);
    },
  };
};

exports.socialRuntime = async db => {
  if (!process.env.SHORTS_TEST_SOCIAL_STATE) return { imports: [], node: undefined };
  const state = async () => JSON.parse(await readFile(process.env.SHORTS_TEST_SOCIAL_STATE, 'utf8'));
  const initial = await state();
  const identity = { network: initial.network, contract: initial.contract };
  const node = {
    getStatus: async () => ({ networkId: identity.network }),
    getContractCode: async address => { assert.equal(address, identity.contract); return { bytecode: initial.bytecode }; },
    getContract: async address => { assert.equal(address, identity.contract); return { active: true }; },
  };
  const { SocialGraphService } = runtimeRequire('../../plugins/social-graph/social-graph.service');
  const { SocialGraphQueryService } = runtimeRequire('../../plugins/social-graph/social-graph-query.service');
  const { SocialGraphController } = runtimeRequire('../../plugins/social-graph/social-graph.controller');
  const { SocialGraphGateway } = runtimeRequire('../../plugins/social-graph/social-graph.gateway');
  const { ProfileReadService } = runtimeRequire('../../profile/services/profile-read.service');
  const queries = new SocialGraphQueryService(db);
  const service = new SocialGraphService({ sdk: { getContext: () => ({ onNode: node }) } }, queries);
  const reader = service.getReader();
  // Keep bytecode/network verification real. Only chain dry-run results are
  // supplied here, as in the Shorts chain fixture. SQL query services stay real.
  reader.policy = async () => {
    await reader.verifyIdentity();
    return { ...identity, config_version: '1', config: { max_following: '1000', max_blocked: '1000', follow_cooldown: '0' }, frozen: false, importing: false };
  };
  reader.relationship = async (from, to) => {
    await reader.verifyIdentity();
    const { edges } = await state();
    const has = (a, b, kind) => edges.some(edge => edge.from === a && edge.to === b && edge.kind === kind);
    return { ...identity, from, to, height: '100', a_follows_b: has(from, to, 'follow'), b_follows_a: has(to, from, 'follow'),
      a_blocked_b: has(from, to, 'block'), b_blocked_a: has(to, from, 'block'), frozen: false, importing: false, advisory: true };
  };
  const { Module } = require('@nestjs/common');
  class SocialFixtureModule {}
  Module({ controllers: [SocialGraphController], providers: [
    SocialGraphGateway,
    { provide: SocialGraphService, useValue: service }, { provide: SocialGraphQueryService, useValue: queries },
    { provide: ProfileReadService, useValue: { summaries: () => assert.fail('Unexpected profile lookup in social fixture') } },
  ] })(SocialFixtureModule);
  return { imports: [SocialFixtureModule], node, gateway: SocialGraphGateway };
};

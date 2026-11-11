// Composed index/plugin -> PostgreSQL notification -> real socket/HTTP consumers.
// Chain observations and canonical MDW input are owned, deterministic fixtures.
const assert = require('node:assert/strict');
const { writeFile, rename } = require('node:fs/promises');
const { join } = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const { AciContractCallEncoder } = require('@aeternity/aepp-calldata');
const { hash, decode, encode, Encoding } = require('@aeternity/aepp-sdk');
const { Tx } = require('../../mdw-sync/entities/tx.entity');
const { ShortsIndexService, SHORTS_INDEX_VERSION } = require('../shorts-index.service');
const { ShortsPluginSyncService } = require('../../plugins/shorts/shorts-plugin-sync.service');
const { ShortsPlugin } = require('../../plugins/shorts/shorts.plugin');
const { assembledAdaptivePlayback } = require('./assembled-adaptive-playback.cjs');
const { ShortsBackfillService } = require('../../plugins/shorts/shorts-backfill.service');

const codec = new AciContractCallEncoder([{ contract: { name: 'Shorts', kind: 'contract_main', typedefs: [], functions: [],
  event: { variant: [{ Published: ['address', 'string'] }, { PaidLike: ['address', 'int', 'string'] },
    { Claimed: ['address', 'int'] }, { Withdrawn: ['string'] }] } } }]);
const integer = bytes => BigInt('0x' + Buffer.from(bytes).toString('hex')).toString();

exports.assembledIndex = async (t, f) => {
  const { owner, admin, meta, scope, id, dir, creator, creatorToken, operatorToken, b, c, request, until, pause } = f;
  const sockets = [];
  t.after(() => sockets.forEach(socket => socket.terminate()));
  async function connect(api) {
    const ws = new WebSocket(api.base.replace('http:', 'ws:') + '/shorts/socket.io/?EIO=4&transport=websocket');
    sockets.push(ws); const frames = []; let joined = false, error;
    ws.on('error', value => { error = value; });
    ws.on('message', bytes => {
      const frame = bytes.toString();
      if (frame === '2') ws.send('3');
      else if (frame.startsWith('0')) ws.send('40/shorts,');
      else if (frame.startsWith('40/shorts,')) joined = true;
      else if (frame.startsWith('42/shorts,')) frames.push(JSON.parse(frame.slice('42/shorts,'.length)));
    });
    await until(() => { if (error) throw error; return joined; }, 5000);
    return { ws, frames, count: () => frames.length };
  }
  const left = await connect(b), right = await connect(c);
  // Drain the documented catch-up invalidation sent when each PG listener starts.
  await pause(200); left.frames.length = right.frames.length = 0;
  const changed = () => owner.query('SELECT pg_notify($1,$2)', ['shorts_updated', JSON.stringify(scope)]);
  async function notified(operation, clients = [left, right]) {
    const before = clients.map(client => client.count());
    await operation();
    await until(() => clients.every((client, i) => client.count() > before[i]), 5000);
    clients.forEach(client => assert.deepEqual(client.frames.at(-1), ['shorts-updated', scope]));
  }
  const record = (await meta.get(scope, id)).record;
  const state = { height: 100, keyHash: encode(randomBytes(32), Encoding.KeyBlockHash),
    shorts: { [id]: { creator: creator.address, cid: record.cid, size: record.bytes, likes: 0, withdrawn: false, likers: [] } } };
  const save = async () => { const file = join(dir, 'chain.json'); await writeFile(file + '.next', JSON.stringify(state), { mode: 0o600 }); await rename(file + '.next', file); };
  await save();
  const contract = { $options: { address: scope.contract },
    $decodeEvents: logs => logs.map(log => { const [name, args] = Object.entries(codec.decodeEvent('Shorts', log.data, log.topics))[0]; return { name, args }; }),
    $call: async (name, args) => { assert.equal(name, 'get_short'); return { decodedResult: state.shorts[args[0]] }; },
  };
  const chain = { contract, release: { network: scope.network, contract: scope.contract, schemaVersion: 1 }, state: { contract: scope.contract } };
  const index = new ShortsIndexService(owner, chain, await require('./index-network.cjs').indexNetworkFixture(owner, chain));
  // This journey controls chain inputs; live endpoint proof is a separate HTTP suite.
  const network = { verify: async () => {}, bindings: () => ({ middleware: f.mdwUrl }),
    json: async url => require('../shorts-upstream').readShortsJson(await fetch(url), 1048576),
    generation: async () => { throw new Error('Unexpected middleware generation read'); },
  };
  const processor = new ShortsPluginSyncService({}, owner, index, network);
  const backfill = new ShortsBackfillService(owner, network, index, processor, { changed });
  const plugin = new ShortsPlugin(owner.getRepository(Tx), {}, processor, index, { changed }, backfill);
  t.after(() => plugin.onModuleDestroy());
  await owner.query("INSERT INTO sync_state VALUES('global',100,now())");
  await owner.query('INSERT INTO shorts_index_backfill(contract,version,complete,covered_height) VALUES($1,$2,true,99)', [scope.contract, SHORTS_INDEX_VERSION]);
  function tx(name, height, shortId = id, account = creator.address) {
    const topics = [integer(hash(name))];
    if (name !== 'Withdrawn') topics.push(integer(decode(account)));
    if (name === 'PaidLike') topics.push('80000000000000000');
    return { hash: encode(randomBytes(32), Encoding.TxHash), block_hash: encode(randomBytes(32), Encoding.MicroBlockHash),
      block_height: height, micro_index: '0', micro_time: String(Date.now()), signatures: [], type: 'ContractCallTx',
      contract_id: scope.contract, caller_id: account,
      function: { Published: 'publish', PaidLike: 'paid_like', Withdrawn: 'withdraw' }[name],
      raw: { returnType: 'ok', log: [{ address: scope.contract, data: encode(Buffer.from(shortId), Encoding.ContractBytearray), topics }] },
      data: { other_plugin: { untouched: true } } };
  }
  async function ingest(row, direction = 'live') {
    await owner.getRepository(Tx).save(row);
    assert.equal((await plugin.processBatch([row], direction)).failed.length, 0);
  }
  async function finance(api = b) {
    const response = await request(api, '/performance?days=7', undefined, creatorToken);
    assert.equal(response.status, 200, JSON.stringify(response)); return response.body.finance;
  }
  const published = tx('Published', 95), like = tx('PaidLike', 99);

  await t.test('plugin commits refresh both sockets; API catalog and creator totals distinguish pending Likes', async () => {
    // Seed a reconciled publisher observation only in this disposable owner schema.
    // The API still verifies the controlled current-chain proof; no signer is run.
    await owner.query("UPDATE shorts_publication_jobs SET status='reconciled',block_hash=$2,block_height=95 WHERE id=$1", [id, state.keyHash]);
    const publication = await request(b, `/${id}/publication`, undefined, creatorToken);
    assert.equal(publication.status, 200, JSON.stringify(publication));
    assert.equal(publication.body.publicationStatus, 'published');
    await notified(() => ingest(published));
    state.shorts[id].likes = 1; state.shorts[id].likers = [creator.address]; await save();
    await notified(() => ingest(like));
    const report = await finance(); assert.equal(report.earned, '0'); assert.equal(report.pending, 1); assert.equal(report.stale, false);
    const feed = await request(c, '/feed?address=' + creator.address);
    assert.equal(feed.status, 200); assert.equal(feed.body.items.length, 1);
    assert.equal(feed.body.items[0].likes, 1); assert.equal(feed.body.items[0].liked, true);
    const stats = await request(b, `/${id}/stats`);
    assert.equal(stats.status, 200);
    assert.deepEqual(stats.body, { likes: '1', comments: '0', commentVersion: '0' });
    const playback = await request(b, `/playback/${id}`); assert.equal(playback.status, 200); assert.equal(playback.body.cid, record.cid);
    assert.equal((await owner.getRepository(Tx).findOneBy({ hash: like.hash })).data.other_plugin.untouched, true);
  });

  await t.test('backfill tip invalidation advances confirmations; replay and canonical rollback do not duplicate revenue', async () => {
    state.height = 102; await save();
    await owner.query("UPDATE sync_state SET tip_height=102,updated_at=now() WHERE id='global'");
    await notified(() => plugin.catchUpToHeight(102));
    let report = await finance(c); assert.equal(report.earned, '0.08'); assert.equal(report.paidLikes, 1); assert.equal(report.pending, 0); assert.equal(report.stale, false);
    // Actual plugin version sweep and raw ABI decoder re-project this tx once.
    await owner.query("UPDATE txs SET data=data - 'shorts' WHERE hash=$1", [like.hash]);
    await notified(() => plugin.updateTransactions());
    assert.equal((await finance()).paidLikes, 1);
    await owner.getRepository(Tx).delete({ hash: like.hash });
    state.shorts[id].likes = 0; state.shorts[id].likers = []; await save();
    await notified(() => plugin.onReorg([like.hash]));
    report = await finance(); assert.equal(report.earned, '0'); assert.equal(report.paidLikes, 0);
    assert.equal((await request(c, '/feed/state', { ids: [id] })).body.items[0].likes, 0);
  });

  await t.test('lost PostgreSQL subscription reconnects and invalidates the still-connected client', async () => {
    const { pid } = await c.command('listener');
    await notified(() => admin.query('SELECT pg_terminate_backend($1)', [pid]), [right]);
    assert.equal(right.ws.readyState, WebSocket.OPEN);
    await notified(changed);
    const disconnected = left.ws; disconnected.terminate();
    const fresh = await connect(b); await notified(changed, [fresh, right]);
    assert.equal((await finance(c)).paidLikes, 0);
  });

  async function withCatalog(check) {
    // Separate catalog identities share the approved original and its immutable assets.
    const rows = Array.from({ length: 24 }, (_, i) => {
      const shortId = randomUUID();
      return { ...record, id: shortId, title: `Catalog fixture ${i + 1}`,
        publication: 'published', createdAt: record.createdAt - (i + 1) * 1000,
        derivatives: { ...record.derivatives, generation: { ...record.derivatives.generation, job: shortId } } };
    });
    const ids = rows.map(row => row.id);
    try {
      await owner.transaction(async manager => {
        for (const row of rows) {
          await manager.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,$5,$6)',
            [scope.network, scope.contract, row.id, row.creator, row.createdAt, row]);
          await manager.query(`INSERT INTO shorts_publication_jobs(network,contract,id,operator,creator,intent,status,block_hash,block_height)
            SELECT network,contract,$4::varchar,operator,creator,intent || jsonb_build_object('id',$4::varchar),'reconciled',block_hash,block_height
            FROM shorts_publication_jobs WHERE network=$1 AND contract=$2 AND id=$3`, [scope.network, scope.contract, id, row.id]);
          state.shorts[row.id] = { ...state.shorts[id], likes: 0, likers: [] };
        }
      });
      await save();
      await check([id, ...ids]);
    } finally {
      await owner.query("UPDATE shorts_content SET body=body || '{\"moderation\":\"pending\"}'::jsonb WHERE network=$1 AND contract=$2 AND id=ANY($3::text[])", [scope.network, scope.contract, ids]);
      for (const shortId of ids) delete state.shorts[shortId];
      await save();
    }
  }
  const playback = f.streamPort ? await assembledAdaptivePlayback(t, { ...f, withCatalog,
    async registerUpload(shortId) {
      // Only the external signer/chain observation is controlled. Upload,
      // approval, storage preparation, journal and plugin consumers remain real.
      const short = (await meta.get(scope, shortId)).record;
      const [job] = await owner.query('SELECT status FROM shorts_publication_jobs WHERE id=$1', [shortId]);
      assert.equal(job.status, 'queued'); assert.ok(short.cid);
      state.shorts[shortId] = { creator: short.creator, cid: short.cid, size: short.bytes, likes: 0, withdrawn: false, likers: [] };
      await save();
      await owner.query("UPDATE shorts_publication_jobs SET status='reconciled',block_hash=$2,block_height=95 WHERE id=$1", [shortId, state.keyHash]);
      await ingest(tx('Published', 95, shortId, short.creator));
    },
    async withdrawUpload(shortId) {
      state.shorts[shortId].withdrawn = true; await save();
      await ingest(tx('Withdrawn', 99, shortId, state.shorts[shortId].creator));
    },
  }) : undefined;

  await t.test('chain withdrawal removes the feed candidate and rejects official playback on both APIs', async () => {
    // Reuse the right client because left was deliberately disconnected above.
    state.shorts[id].withdrawn = true; await save();
    const withdrawn = tx('Withdrawn', 99);
    await notified(() => ingest(withdrawn), [right]);
    for (const api of [b, c]) {
      assert.equal((await request(api, `/playback/${id}`)).status, 404);
      assert.deepEqual((await request(api, '/feed/state', { ids: [id] })).body.items, []);
      const studio = await request(api, '/studio/content', undefined, creatorToken);
      assert.equal(studio.status, 200); assert.equal(studio.body.counts.withdrawn, 1);
    }
    await playback?.denied('withdrawal');
    await owner.getRepository(Tx).delete({ hash: withdrawn.hash });
    state.shorts[id].withdrawn = false; await save();
    await notified(() => plugin.onReorg([withdrawn.hash]), [right]);
    assert.equal((await request(b, `/playback/${id}`)).status, 200);
    await playback?.restored();
  });

  await t.test('committed content restrictions invalidate live clients; rolled-back metadata stays invisible', async () => {
    // Prove transaction-bound delivery, not an application callback before commit.
    const before = right.count();
    await assert.rejects(owner.transaction(async manager => {
      await manager.query("UPDATE shorts_content SET body=jsonb_set(body,'{title}','\"rolled back\"'::jsonb) WHERE id=$1", [id]);
      throw new Error('owned rollback');
    }), /owned rollback/);
    await pause(200); assert.equal(right.count(), before);
    await owner.query('UPDATE shorts_content SET body=body WHERE id=$1', [id]);
    await pause(200); assert.equal(right.count(), before, 'unchanged bodies do not send invalidations');
    await notified(async () => {
      const rejected = await request(b, `/review/${id}`, { approved: false, reason: 'Owned fixture policy test' }, operatorToken);
      assert.equal(rejected.status, 201, JSON.stringify(rejected));
    }, [right]);
    assert.equal((await request(c, `/playback/${id}`)).status, 404);
    assert.deepEqual((await request(c, '/feed/state', { ids: [id] })).body.items, []);
    await playback?.denied('restriction');
  });
  await playback?.close();
};

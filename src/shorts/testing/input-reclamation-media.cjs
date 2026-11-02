// Opt-in integration against a disposable paired admission-guard/Kubo container.
// Initial media comes from the real upload/encoder/publisher fixture. Fault setup
// uses its private raw RPC; lifecycle mutations use the actual authenticated guard.
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { mkdir, writeFile, readFile } = require('node:fs/promises');
const { join, isAbsolute } = require('node:path');
const { once } = require('node:events');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const http = require('node:http');
const { DataSource } = require('typeorm');
const { ShortsMediaService } = require('../shorts-media.service');
const { ShortsDeliverySelectionService } = require('../shorts-delivery-selection.service');
const { ShortsInputReclamationReservationsService } = require('../shorts-input-reclamation-reservations.service');
const { ShortsInputReclamationPermitsService } = require('../shorts-input-reclamation-permits.service');
const { ShortsReclamationReleaseService } = require('../shorts-reclamation-release.service');
const { ShortsInputReclamationService } = require('../shorts-input-reclamation.service');
const { ShortsPinTransfersService } = require('../shorts-pin-transfers.service');
const { ShortsStorageRecoveriesService } = require('../shorts-storage-recoveries.service');
const { ShortsStorageRecoveryService } = require('../shorts-storage-recovery.service');

exports.exercise = async f => {
  const { t, owner, scope, schema, dir, shorts, record, video, descriptor, prepared, rpc, retention } = f;
  const gate = new URL(process.env.SHORTS_TEST_KUBO_GATE), container = process.env.SHORTS_TEST_KUBO_CONTAINER;
  const tokenFile = process.env.SHORTS_TEST_IPFS_TOKEN_FILE;
  assert.equal(gate.hostname, '127.0.0.1'); assert.equal(gate.pathname, '/api/v0');
  assert.match(container, /^sh-shorts-reclaim-[a-f0-9-]{36}$/); assert.ok(isAbsolute(tokenFile));
  const inspect = async () => JSON.parse((await exec('docker', ['inspect', container])).stdout)[0];
  const owned = await inspect();
  assert.equal(owned.Config.Labels['org.superhero.test.reclamation'], 'true');
  assert.equal(owned.NetworkSettings.Ports['5010/tcp'][0].HostIp, '127.0.0.1');
  assert.equal(owned.NetworkSettings.Ports['5010/tcp'][0].HostPort, gate.port);
  assert.equal(owned.HostConfig.PortBindings['5010/tcp'][0].HostPort, gate.port,
    'Use a fixed test port; Docker may reassign an automatically published port on restart');
  assert.match(owned.HostConfig.PortBindings['5001/tcp'][0].HostPort, /^[1-9][0-9]+$/);
  const token = (await readFile(tokenFile, 'utf8')).trim(); assert.match(token, /^[a-f0-9]{64}$/);
  const role = 'shreclaim_' + randomUUID().replaceAll('-', ''), password = randomUUID();
  let db, media, service, recovery, lost = false, writes = 0;
  const services = [], sockets = new Set(), originalEnv = { ...process.env };
  const proxy = http.createServer((req, res) => {
    const url = new URL(req.url, gate.origin), unpin = url.pathname === '/api/v0/shorts/unpin';
    if (unpin) writes++;
    const upstream = http.request(url, { method: req.method, headers: { ...req.headers, host: url.host } }, response => {
      if (unpin && lost) {
        lost = false; response.resume(); response.on('end', () => res.destroy());
      } else { res.writeHead(response.statusCode, response.headers); response.pipe(res); }
    });
    upstream.on('error', () => res.destroy()); res.on('close', () => upstream.destroy()); req.pipe(upstream);
  });
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const waitQuiet = async permit => {
    const remaining = Date.parse(permit.quietUntil) - Date.now() + 100;
    assert.ok(remaining < 51000);
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
  };
  try {
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}; GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role};
      GRANT INSERT,UPDATE ON shorts_input_reclamation_reservations,shorts_input_reclamation_permits TO ${role};
      GRANT INSERT ON shorts_input_reclamation_releases,shorts_storage_recoveries TO ${role};
      GRANT EXECUTE ON FUNCTION shorts_input_reclamation_roots(text) TO ${role}`);
    const url = new URL(process.env.SHORTS_TEST_PG_URL); url.username = role; url.password = password;
    db = new DataSource({ ...owner.options, url: url.href }); await db.initialize();
    await assert.rejects(db.query('DELETE FROM shorts_content'), /permission denied/);
    await assert.rejects(db.query('ALTER TABLE shorts_input_reclamation_permits DISABLE TRIGGER ALL'), /owner/);
    Object.assign(process.env, { SHORTS_IPFS_API: `http://127.0.0.1:${proxy.address().port}/api/v0`, SHORTS_IPFS_TOKEN_FILE: tokenFile,
      SHORTS_IPFS_EXPIRING_WRITES: 'true', SHORTS_DELIVERY_INPUT_RECLAMATION_ENABLED: 'true', SHORTS_STORAGE_RECOVERY_ENABLED: 'true' });
    media = new ShortsMediaService({});
    const selections = new ShortsDeliverySelectionService(db), reservations = new ShortsInputReclamationReservationsService(db);
    const permits = new ShortsInputReclamationPermitsService(db), releases = new ShortsReclamationReleaseService(db);
    const boot = () => {
      const next = new ShortsInputReclamationService(shorts, media, selections, reservations, permits, releases);
      services.push(next); return next;
    };
    service = boot();
    recovery = new ShortsStorageRecoveryService(new ShortsStorageRecoveriesService(db), new ShortsPinTransfersService(db), permits, service, media);
    const signal = () => AbortSignal.timeout(30000), input = record.derivatives.cid;
    const canonical = (await owner.query('SELECT body FROM shorts_content WHERE network=$1 AND contract=$2 AND id=$3', [scope.network, scope.contract, record.id]))[0].body;
    const pinned = async cid => !!JSON.parse((await rpc('pin/ls', { type: 'recursive' })).toString()).Keys?.[cid];
    const unchanged = async () => {
      const row = (await owner.query('SELECT body FROM shorts_content WHERE network=$1 AND contract=$2 AND id=$3', [scope.network, scope.contract, record.id]))[0].body;
      assert.deepEqual(row, canonical); assert.deepEqual(await rpc('cat', { arg: record.cid }), video);
      await media.verifyDurableDelivery(record, descriptor, prepared);
    };
    await t.test('real reclamation rejects retained roots and holds before dispatching an unpin', async () => {
      const capabilities = await media.reclamationStorage(signal());
      assert.equal(capabilities.peerId, JSON.parse((await rpc('id', {})).toString()).ID);
      for (const cid of [record.cid, record.derivatives.assetsCid, prepared.cid]) await assert.rejects(service.reclaim(cid, randomUUID()), /retained/);
      const hold = randomUUID(); await retention.hold({ id: hold, resourceId: record.id, reason: 'legal', reference: 'reclamation-integration' });
      try { await assert.rejects(service.reclaim(input, randomUUID()), /retained|policy/); }
      finally { await retention.release(hold); }
      const incomplete = randomUUID(); await rpc('pin/rm', { arg: prepared.cid });
      try { await assert.rejects(service.reclaim(input, incomplete), /pin/i); }
      finally { await rpc('pin/add', { arg: prepared.cid }); }
      assert.equal((await reservations.get(incomplete)).state, 'released');
      assert.equal(await permits.get(incomplete), undefined);
      assert.equal(writes, 0); assert.ok(await pinned(input));
    });
    await t.test('the real guard removes only retired encoded inputs and release waits for the actual quiet period', async () => {
      const operation = randomUUID();
      const result = await service.reclaim(input, operation); assert.equal(result.permit.state, 'removed');
      assert.equal(writes, 1); assert.equal(await pinned(input), false);
      assert.deepEqual(await service.reclaim(input, operation), result); assert.equal(writes, 1);
      await assert.rejects(service.release(operation), /quiet period/);
      await unchanged(); await waitQuiet(result.permit);
      const released = await service.release(operation); assert.equal(released.observed_pin, false);
      assert.deepEqual(await service.release(operation), released); assert.equal((await reservations.get(operation)).state, 'released');
      assert.equal(writes, 1);
    });
    await t.test('a lost real unpin response stays fenced across coordinator restart and requires paired-node recovery', async () => {
      // Restore this fixture's input pin to exercise a distinct operation; do not
      // change any old receipt, acknowledgement, expiry or reference metadata.
      await rpc('pin/add', { arg: input }); assert.ok(await pinned(input));
      const operation = randomUUID(); lost = true;
      await assert.rejects(service.reclaim(input, operation));
      const permit = await permits.get(operation); assert.equal(permit.state, 'uncertain');
      assert.equal(writes, 2); assert.equal(await pinned(input), false);
      await service.onModuleDestroy(); service = boot();
      await recovery.onModuleDestroy();
      recovery = new ShortsStorageRecoveryService(new ShortsStorageRecoveriesService(db), new ShortsPinTransfersService(db), permits, service, media);
      assert.equal((await service.reclaim(input, operation)).permit.state, 'uncertain'); assert.equal(writes, 2);
      await assert.rejects(service.release(operation), /known bound/);
      await assert.rejects(reservations.cancel(operation));
      await waitQuiet(permit); await assert.rejects(recovery.recover('unpin', operation), /epoch|process|restarted/);
      const before = await inspect(); assert.equal(before.Id, owned.Id); assert.equal(before.Image, owned.Image);
      await exec('docker', ['restart', container], { timeout: 60000 });
      let ready;
      for (let i = 0; i < 60; i++) {
        try { ready = await media.reclamationStorage(signal()); if (ready.nodeEpoch !== permit.storage.epoch) break; } catch { /* Paired node starting. */ }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.equal(ready?.peerId, permit.storage.peerId); assert.notEqual(ready?.nodeEpoch, permit.storage.epoch);
      const result = await recovery.recover('unpin', operation);
      assert.deepEqual(await recovery.recover('unpin', operation), result);
      assert.equal((await reservations.get(operation)).state, 'released'); assert.equal(writes, 2);
      await unchanged();
    });
    await t.test('original and every adaptive track survive disposable-node garbage collection after input reclamation', async () => {
      // This privileged raw RPC is exposed only by the disposable fixture. No
      // production guard route or automatic GC setting is added or enabled.
      await rpc('repo/gc', {});
      assert.equal(await pinned(input), false); await unchanged();
      const response = await fetch(`${process.env.SHORTS_TEST_KUBO_API}/block/stat?arg=${input}`, { method: 'POST', signal: signal() });
      assert.equal(response.status, 500); await response.body?.cancel();
      const directory = join(dir, 'reclaimed-playback'); await mkdir(directory);
      for (const file of prepared.files) {
        const bytes = await rpc('cat', { arg: `/ipfs/${prepared.cid}/${file.name}` });
        assert.equal(bytes.length, file.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
        await writeFile(join(directory, file.name), bytes);
      }
      for (const playlist of Object.keys(prepared.playlists)) await exec('ffmpeg', ['-nostdin', '-v', 'error', '-i', join(directory, playlist), '-f', 'null', '-'], { timeout: 30000 });
      t.diagnostic(JSON.stringify({ unpinRequests: writes, originalBytesRetained: record.bytes,
        encodedInputBytesUnpinned: record.files.filter(file => /^(video-|audio-)/.test(file.name)).reduce((sum, file) => sum + file.bytes, 0),
        decodedTracksAfterGc: Object.keys(prepared.playlists).length }));
    });
    await require('./input-regeneration-media.cjs').exercise(f);
  } finally {
    await recovery?.onModuleDestroy();
    for (const item of services) await item.onModuleDestroy();
    await media?.onModuleDestroy();
    for (const socket of sockets) socket.destroy();
    if (proxy.listening) await new Promise(resolve => proxy.close(resolve));
    if (db?.isInitialized) await db.destroy();
    await owner.query(`DROP OWNED BY ${role}; DROP ROLE IF EXISTS ${role}`);
    process.env = originalEnv;
  }
};

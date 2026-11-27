// Runs only after the real private cleanup, input unpin and disposable-node GC.
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { mkdir, readFile, writeFile, readdir } = require('node:fs/promises');
const { join } = require('node:path');
const { once } = require('node:events');
const exec = require('node:util').promisify(require('node:child_process').execFile);
const { ListObjectVersionsCommand } = require('@aws-sdk/client-s3');
const { ShortsMetadataService } = require('../shorts-metadata.service');
const { ShortsRecordsService } = require('../shorts-records.service');
const { ShortsPrivateObjectsService } = require('../shorts-private-objects.service');
const { ShortsPrivateMediaService } = require('../shorts-private-media.service');
const { ShortsSourceReaderService } = require('../shorts-source-reader.service');
const { ShortsScratchService } = require('../shorts-scratch.service');
const { ShortsMediaService } = require('../shorts-media.service');
const { ShortsOriginalRestagingService } = require('../shorts-original-restaging.service');
const { ShortsDeliveryStagingService } = require('../shorts-delivery-staging.service');
const { ShortsDeliveryGenerationsService } = require('../shorts-delivery-generations.service');
const { ShortsDeliveryPackagesService } = require('../shorts-delivery-packages.service');
const { ShortsDeliveryAcknowledgementService } = require('../shorts-delivery-acknowledgement.service');
const { ShortsDeliverySelectionService } = require('../shorts-delivery-selection.service');
const { ShortsDeliveryActivationService } = require('../shorts-delivery-activation.service');
const { ShortsPinTransfersService } = require('../shorts-pin-transfers.service');

exports.exercise = async f => {
  const { t, owner, scope, api, shorts, record, video, descriptor, prepared, raw, bucket, rpc, dir, ownedPins, startWorker, transcoder } = f;
  const metadata = new ShortsMetadataService(owner), objects = api.get(ShortsPrivateObjectsService);
  const privateMedia = api.get(ShortsPrivateMediaService), records = api.get(ShortsRecordsService);
  const scratch = api.get(ShortsScratchService), transfers = new ShortsPinTransfersService(owner);
  // The outer upload fixture already isolates admission; this phase exercises
  // actual media IO, SQL barriers and guard transport, not distributed load.
  const publisher = new ShortsMediaService({}, privateMedia, records, { acquire: async () => ({ signal: new AbortController().signal, release: async () => {} }) }, scratch, transfers);
  const selections = new ShortsDeliverySelectionService(owner), staging = new ShortsDeliveryStagingService(owner, metadata);
  const restaging = new ShortsOriginalRestagingService(metadata, publisher, objects, staging);
  const generations = new ShortsDeliveryGenerationsService(owner, metadata), packages = new ShortsDeliveryPackagesService(owner);
  const acknowledgements = new ShortsDeliveryAcknowledgementService(publisher, packages, transfers);
  const originalSelection = await selections.state(scope, record), canonical = (await metadata.get(scope, record.id)).record;
  const chain = structuredClone(shorts.chain.state), publication = structuredClone(await shorts.chain.read('get_short'));
  const jobId = randomUUID(), oldSelectionFlag = process.env.SHORTS_DELIVERY_SELECTION_ENABLED;
  process.env.SHORTS_DELIVERY_SELECTION_ENABLED = 'true';
  const activation = new ShortsDeliveryActivationService(shorts, publisher, selections);
  let worker, candidate, replacement;
  const stopWorker = async () => {
    if (worker && worker.process.exitCode === null && worker.process.signalCode === null) {
      worker.process.kill('SIGTERM'); await once(worker.process, 'exit');
    }
  };
  const unchanged = async () => {
    assert.deepEqual((await metadata.get(scope, record.id)).record, canonical);
    assert.deepEqual(shorts.chain.state, chain);
    assert.deepEqual(await shorts.chain.read('get_short'), publication);
    assert.deepEqual(await rpc('cat', { arg: record.cid }), video);
    await publisher.verifyDurableDelivery(record, descriptor, prepared);
  };
  try {
    await publisher.onModuleInit();
    await t.test('after cleanup restaging requires the pinned original and creates fresh bounded encrypted parts', async () => {
      const absent = await fetch(`${process.env.SHORTS_TEST_KUBO_API}/block/stat?arg=${record.derivatives.cid}`, { method: 'POST' });
      assert.equal(absent.status, 500); await absent.body?.cancel();
      let retiredSourceRead = false;
      await assert.rejects(privateMedia.withOriginal(scope, record, () => { retiredSourceRead = true; }));
      assert.equal(retiredSourceRead, false);
      const before = await raw.send(new ListObjectVersionsCommand({ Bucket: bucket }));
      await rpc('pin/rm', { arg: record.cid });
      try { await assert.rejects(restaging.restage(scope, record.id, jobId), /not recursively pinned/); }
      finally { await rpc('pin/add', { arg: record.cid }); }
      assert.equal(await staging.get(scope, jobId), undefined);
      assert.equal((await owner.query('SELECT count(*)::int n FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND id=$3', [scope.network, scope.contract, jobId]))[0].n, 0);
      const after = await raw.send(new ListObjectVersionsCommand({ Bucket: bucket }));
      assert.deepEqual(after.Versions, before.Versions); assert.deepEqual(after.DeleteMarkers, before.DeleteMarkers);
      const result = { jobId, shortId: record.id, ready: true };
      assert.deepEqual(await restaging.restage(scope, record.id, jobId), result);
      assert.deepEqual(await restaging.restage(scope, record.id, jobId), result);
      const staged = await staging.get(scope, jobId);
      assert.equal(staged.state, 'ready'); assert.equal(staged.input.sha256, record.original.sha256);
      assert.equal(staged.input.bytes, record.bytes); assert.equal(staged.input.processingProfile, 'original-h264-v1');
      const parts = JSON.parse(staged.manifest).parts;
      assert.equal(parts.length, Math.ceil(video.length / 1048576));
      assert.ok(parts.every(part => part.object.key.includes(`/${jobId}/`) && part.object.bytes <= 1048576));
      const restored = join(dir, 'restaged-original');
      await new ShortsSourceReaderService(objects).readToFile(scope, { id: jobId, creator: record.creator, input: staged.input }, restored);
      assert.deepEqual(await readFile(restored), video);
      await unchanged(); assert.deepEqual(await selections.state(scope, record), originalSelection);
    });
    await t.test('a restricted real worker rebuilds a 1080p60 generation and the guard accepts fresh pin authority after cleanup', async () => {
      worker = startWorker(jobId);
      const outcome = await worker.wait('result'); assert.equal(outcome.status, 'ready');
      await stopWorker();
      candidate = await generations.get(scope, jobId);
      assert.equal(candidate.record.cid, record.cid); assert.deepEqual(candidate.record.original, record.original);
      assert.equal(candidate.record.derivatives.generation.job, jobId);
      assert.notEqual(candidate.sourceKey, originalSelection.sourceKey);
      for (const cid of [candidate.record.cid, candidate.record.derivatives.cid, candidate.record.derivatives.assetsCid]) ownedPins.add(cid);
      await publisher.ensurePinned(candidate.record);
      const writes = await owner.query('SELECT cid,purpose,state,node_peer_id,node_epoch FROM shorts_pin_transfers WHERE job_id=$1', [jobId]);
      assert.ok(writes.some(row => row.purpose === 'inputs' && row.cid === candidate.record.derivatives.cid));
      assert.ok(writes.every(row => row.state === 'pinned' && row.node_peer_id && row.node_epoch));
      replacement = await transcoder.prepare(candidate.descriptor, () => shorts.ensurePlayable(record.id));
      ownedPins.add(replacement.cid);
      await acknowledgements.acknowledge(candidate.record, candidate.descriptor, replacement,
        () => shorts.ensurePlayable(record.id), AbortSignal.timeout(30000));
      await publisher.verifyDurableDelivery(candidate.record, candidate.descriptor, replacement);
      const playback = join(dir, 'regenerated-playback'); await mkdir(playback);
      for (const file of replacement.files) {
        const bytes = await rpc('cat', { arg: `/ipfs/${replacement.cid}/${file.name}` });
        assert.equal(bytes.length, file.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
        await writeFile(join(playback, file.name), bytes);
      }
      for (const playlist of Object.keys(replacement.playlists)) await exec('ffmpeg', ['-nostdin', '-v', 'error', '-i', join(playback, playlist), '-f', 'null', '-'], { timeout: 30000 });
      const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', join(playback, 'v1080.m3u8')])).stdout).streams[0];
      assert.equal(probe.width, 1080); assert.equal(probe.height, 1920); assert.equal(probe.r_frame_rate, '60/1');
      assert.deepEqual(await readdir(join(dir, 'streaming')), []);
      await unchanged(); assert.deepEqual(await selections.state(scope, record), originalSelection);
    });
    assert.ok(candidate && replacement, 'Regenerated delivery must be prepared before activation');
    await t.test('regenerated playback activates and rolls back after cleanup without changing the post or original CID', async () => {
      const selected = await activation.select(record.id, candidate.sourceKey, originalSelection, randomUUID());
      assert.equal(selected.sourceKey, candidate.sourceKey); assert.equal(selected.revision, '1');
      assert.deepEqual(await selections.state(scope, record), { sourceKey: candidate.sourceKey, revision: '1' });
      await unchanged();
      const rollback = await activation.select(record.id, originalSelection.sourceKey,
        { sourceKey: selected.sourceKey, revision: selected.revision }, randomUUID(), 'rollback');
      assert.equal(rollback.sourceKey, originalSelection.sourceKey); assert.equal(rollback.revision, '2');
      await unchanged(); await publisher.verifyDurableDelivery(candidate.record, candidate.descriptor, replacement);
      t.diagnostic(JSON.stringify({ originalBytesRestaged: record.bytes, regeneratedTracks: Object.keys(replacement.playlists).length,
        originalCidPreserved: true, canonicalRecordPreserved: true, reusedEncodedCid: candidate.record.derivatives.cid === record.derivatives.cid,
        rollbackRevision: rollback.revision }));
    });
  } finally {
    await stopWorker(); await activation.onModuleDestroy(); await publisher.onModuleDestroy();
    if (oldSelectionFlag === undefined) delete process.env.SHORTS_DELIVERY_SELECTION_ENABLED;
    else process.env.SHORTS_DELIVERY_SELECTION_ENABLED = oldSelectionFlag;
  }
};

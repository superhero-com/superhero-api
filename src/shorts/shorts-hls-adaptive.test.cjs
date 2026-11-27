const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hlsSourceKey, hlsObservation } = require('./shorts-hls-inventory-data');
const { shortsPlaybackDescriptor } = require('./shorts-playback-descriptor');
const fixture = require('./testing/hls-v3.json');
const { fullAdaptivePackage } = require('./testing/hls-v3-fixture.cjs');

test('API inventory matches the streaming golden source key and full adaptive graph', () => {
  assert.equal(hlsSourceKey(fixture.descriptor), fixture.sourceKey);
  const descriptor = shortsPlaybackDescriptor(fixture.descriptor, { network: 'ae_uat', contract: 'ct_protocol' });
  assert.deepEqual(descriptor, fixture.descriptor);
  const observed = hlsObservation(fixture.sourceKey, JSON.stringify(fixture.package));
  assert.equal(observed.version, 3); assert.equal(observed.cid, fixture.package.cid);
  assert.equal(observed.bytes, fixture.package.files.reduce((sum, file) => sum + file.bytes, 0));
  assert.deepEqual(observed.files, fixture.package.files);
  const reordered = structuredClone(descriptor); reordered.files.reverse(); reordered.derivatives.videos.reverse();
  assert.equal(hlsSourceKey(reordered), fixture.sourceKey);
  for (const generation of [{job: descriptor.id, fence: '2'}, {job: 'regeneration-job', fence: '1'}]) {
    const changed = structuredClone(descriptor); changed.derivatives.generation = generation;
    assert.notEqual(hlsSourceKey(changed), fixture.sourceKey);
  }
  for (const mutate of [value => { delete value.network; }, value => { delete value.contract; },
    value => { delete value.derivatives.generation; }, value => { value.derivatives.generation.fence = 1; },
    value => { value.derivatives.generation.fence = '9223372036854775808'; }]) {
    const changed = structuredClone(descriptor); mutate(changed); assert.throws(() => hlsSourceKey(changed));
  }
  for (const field of ['network', 'contract', 'cid', 'bytes']) {
    const changed = structuredClone(descriptor);
    changed[field] = { network: 'ae_mainnet', contract: 'ct_different', cid: 'bafy'+'d'.repeat(50), bytes: 4097 }[field];
    assert.notEqual(hlsSourceKey(changed), fixture.sourceKey);
  }
});

test('adaptive inventory rejects unknown, unaligned, oversized and incomplete graphs', () => {
  for (const mutate of [
    value => { value.version = 4; }, value => { delete value.playlists; }, value => { delete value.playlists['arescue.m3u8']; },
    value => { value.playlists['unlisted.m3u8'] = value.playlist; },
    value => { value.playlists['vrescue.m3u8'] = value.playlists['vrescue.m3u8'].replace('2.000000', '1.000000'); },
    value => { value.playlist = value.playlist.replace('v1080.m3u8', 'https://external.example/a.m3u8'); },
    value => { value.files.push(value.files[0]); }, value => { value.files[0].sha256 = '0'.repeat(64); },
    value => { value.files.find(file => file.name === 'vrescue-segment-000.m4s').bytes += 10000; },
    value => { value.playlists['v1080.m3u8'] += '#EXT-X-KEY:METHOD=AES-128,URI="key"\n'; },
  ]) {
    const value = structuredClone(fixture.package); mutate(value);
    assert.throws(() => hlsObservation(fixture.sourceKey, JSON.stringify(value)));
  }
  assert.throws(() => hlsObservation(fixture.sourceKey, 'x'.repeat(131073)));
});

test('full sixty-second ladders fit the new bounds without weakening legacy limits', () => {
  const prepared = fullAdaptivePackage(), raw = JSON.stringify(prepared);
  const observed = hlsObservation(fixture.sourceKey, raw);
  assert.equal(observed.files.length, 225); assert.ok(observed.bytes > 100000000); assert.ok(observed.bytes < 192 * 1048576);
  assert.ok(Buffer.byteLength(raw) > 32768); assert.ok(Buffer.byteLength(raw) < 131072);
  const legacy = structuredClone(prepared); delete legacy.version;
  assert.throws(() => hlsObservation(fixture.sourceKey, JSON.stringify(legacy)));
});

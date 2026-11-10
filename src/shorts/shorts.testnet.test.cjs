const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Contract, Node } = require('@aeternity/aepp-sdk');

function serviceUrl(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1'));
  assert.ok(!url.username && !url.password && !url.search && !url.hash);
  return url;
}
const http = (url, options) => fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });

test('published testnet Short matches its contract record and plays through adaptive HLS', {
  skip: process.env.SHORTS_TESTNET_E2E !== '1', timeout: 180000,
}, async () => {
  const id = process.env.SHORTS_TEST_VIDEO_ID;
  assert.match(id || '', /^[a-zA-Z0-9-]{1,80}$/, 'Choose an existing published testnet Short');
  const api = serviceUrl(process.env.SHORTS_TEST_API_URL || 'http://127.0.0.1:3334/api/shorts');
  const edge = serviceUrl(process.env.SHORTS_STREAM_URL || 'http://127.0.0.1:3335');
  const catalog = async path => {
    const response = await http(api.href.replace(/\/$/, '') + path);
    assert.equal(response.status, 200, 'Public catalog request failed');
    return response.json();
  };
  const [cfg, video, descriptor] = await Promise.all([catalog('/config'), catalog('/shared/' + id), catalog('/playback/' + id)]);
  assert.equal(cfg.network, 'ae_uat');
  assert.equal(cfg.release.schemaVersion, 2);
  assert.equal(cfg.release.node, 'https://testnet.aeternity.io');
  assert.equal(cfg.contract, cfg.release.contract);
  assert.equal(cfg.likeMode, 'free');
  assert.equal(cfg.uploads.format, 'original-file-v1');
  assert.equal(cfg.uploads.transport, 'direct-s3-v1');
  assert.equal(video.id, id); assert.equal(video.publicationStatus, 'published');
  assert.equal(descriptor.id, id); assert.equal(descriptor.contract, cfg.contract);
  assert.equal(descriptor.cid, video.cid); assert.equal(descriptor.bytes, video.bytes);
  assert.equal(descriptor.original.version, 1); assert.ok(descriptor.derivatives.videos.length >= 2);

  const node = new Node(cfg.release.node, { retryCount: 0 });
  assert.equal((await node.getStatus()).networkId, 'ae_uat');
  const digest = value => createHash('sha256').update(value).digest('hex');
  assert.equal(digest((await node.getContractCode(cfg.contract)).bytecode), cfg.release.bytecodeHash);
  assert.equal(digest(JSON.stringify(cfg.aci)), cfg.release.aciHash);
  const contract = await Contract.initialize({ onNode: node, aci: cfg.aci, address: cfg.contract });
  const { decodedResult } = await contract.$call('get_video', [id], { callStatic: true });
  assert.equal(decodedResult.creator, video.creator); assert.equal(decodedResult.cid, video.cid);
  assert.equal(BigInt(decodedResult.size), BigInt(video.bytes)); assert.equal(decodedResult.withdrawn, false);

  const root = new URL('/videos/' + id + '/', edge);
  const mediaUrl = (value, parent = root) => {
    const url = new URL(value, parent);
    assert.equal(url.origin, root.origin);
    assert.ok(url.pathname.startsWith(root.pathname) && url.searchParams.has('token'), 'Expected a signed playback asset');
    return url;
  };
  let session;
  for (let i = 0; i < 40; i++) {
    const response = await http(new URL('playback', root), { method: 'POST' });
    if (response.status === 200) { session = await response.json(); break; }
    assert.equal(response.status, 202, 'Playback session request failed');
    await response.body?.cancel();
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.ok(session?.manifest, 'Expected prepared HLS playback');
  const master = mediaUrl(session.manifest);
  const playlist = async url => {
    const response = await http(url);
    assert.equal(response.status, 200, 'Playlist request failed');
    const text = await response.text(); assert.match(text, /^#EXTM3U/);
    return text;
  };
  const variants = (await playlist(master)).split('\n').filter(line => line && !line.startsWith('#'));
  assert.equal(variants.length, descriptor.derivatives.videos.length);
  const variant = mediaUrl(variants[0], master);
  const rendition = await playlist(variant); assert.match(rendition, /#EXT-X-ENDLIST/);
  const segment = rendition.split('\n').find(line => line && !line.startsWith('#'));
  assert.ok(segment);
  const bytes = await http(mediaUrl(segment, variant), { headers: { Range: 'bytes=0-63' } });
  assert.equal(bytes.status, 206); assert.equal((await bytes.arrayBuffer()).byteLength, 64);
});

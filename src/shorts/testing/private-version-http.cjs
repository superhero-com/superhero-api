require('reflect-metadata');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { randomBytes, createCipheriv } = require('node:crypto');
const { ShortsPrivateObjectsService } = require('../shorts-private-objects.service');
const scope = { network: 'ae_uat', contract: 'ct_versionFixture' };
const candidate = 'old/version+with space=?';
const current = 'current/version+1=';

async function fixture(t) {
  const state = { current, requests: [], versions: new Map(), reads: 0, heads: 0, active: 0, peak: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const version = url.searchParams.get('versionId');
    state.requests.push({ method: req.method, version });
    assert.ok(req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 ') || (req.method === 'DELETE' && url.searchParams.has('X-Amz-Signature')));
    if (url.searchParams.has('versioning')) {
      res.setHeader('content-type', 'application/xml'); res.end(`<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${state.versioning || 'Enabled'}</Status></VersioningConfiguration>`); return;
    }
    if (url.searchParams.has('lifecycle')) {
      res.setHeader('content-type', 'application/xml');
      if (state.lifecycleEnabled) res.end('<LifecycleConfiguration><Rule><ID>automatic</ID><Status>Enabled</Status><Expiration><Days>1</Days></Expiration></Rule></LifecycleConfiguration>');
      else { res.statusCode = 404; res.end('<Error><Code>NoSuchLifecycleConfiguration</Code></Error>'); } return;
    }
    if (req.method === 'DELETE') {
      assert.ok(version && (state.allowCurrentRemoval || version !== state.current), 'current removal requires the retirement fixture');
      assert.equal(req.headers['x-amz-bypass-governance-retention'], undefined);
      assert.equal(url.searchParams.get('X-Amz-Expires'), String(state.expectedExpires ?? 30));
      assert.match(url.searchParams.get('X-Amz-Date'), /^\d{8}T\d{6}Z$/);
      state.deletes = (state.deletes || 0) + 1;
      if (state.denyDelete) { res.statusCode = 403; res.end('<Error><Code>AccessDenied</Code></Error>'); return; }
      if (!state.keepCandidate) state.versions.delete(version);
      if (state.allowCurrentRemoval && version === state.current && !state.keepCandidate)
        state.current = [...state.versions.keys()].at(-1);
      if (state.loseDelete) { res.destroy(); return; }
      res.statusCode = 204; res.setHeader('x-amz-version-id', version); res.end(); return;
    }
    assert.ok(['GET', 'HEAD'].includes(req.method));
    if (req.method === 'HEAD' && version) {
      const data = state.versions.get(version);
      if (!data) { res.statusCode = state.hideAbsence ? 403 : 404; res.end(); return; }
      res.setHeader('x-amz-version-id', state.wrongVersionHead ? 'wrong-version' : version);
      if (state.versionMarker) res.setHeader('x-amz-delete-marker', 'true');
      res.setHeader('content-length', data.length); res.end(); return;
    }
    if (req.method === 'HEAD') {
      state.heads++;
      res.setHeader('x-amz-version-id', state.changeCurrent && state.heads === 2 ? 'replacement' : state.current);
      if (state.currentMarker) res.setHeader('x-amz-delete-marker', 'true');
      res.setHeader('content-length', state.length + (state.badHeadSize ? 1 : 0));
      res.end(); return;
    }
    state.reads++;
    state.peak = Math.max(state.peak, ++state.active);
    res.once('close', () => state.active--);
    const bytes = state.versions.get(version);
    if (!bytes) { res.statusCode = 404; res.end(); return; }
    res.setHeader('x-amz-version-id', state.wrongEcho && version === candidate ? current : version);
    if (state.omitEcho) res.removeHeader('x-amz-version-id');
    if (state.marker && version === candidate) res.setHeader('x-amz-delete-marker', 'true');
    res.setHeader('content-length', bytes.length + (state.badGetSize ? 1 : 0));
    if (state.hang && version === candidate) {
      res.write(bytes.subarray(0, 37));
      state.onHang(); return;
    }
    // Deliberately fragment the envelope header and stream body chunks.
    res.write(bytes.subarray(0, 3));
    res.write(bytes.subarray(3, 19));
    let offset = 19;
    const send = () => {
      while (offset < bytes.length) {
        const chunk = bytes.subarray(offset, offset + 16384); offset += chunk.length;
        if (!res.write(chunk)) { res.once('drain', send); return; }
      }
      res.end();
    };
    send();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { endpoint: `http://127.0.0.1:${server.address().port}`, region: 'us-east-1', bucket: 'version-test', prefix: 'quarantine', forcePathStyle: true,
    credentials: { accessKeyId: 'test-only', secretAccessKey: 'test-only' }, activeKeyId: 'key1', keys: { key1: randomBytes(32) } };
  const service = new ShortsPrivateObjectsService(config);
  t.after(async () => { service.onModuleDestroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const send = service.client.send.bind(service.client);
  const copies = [];
  service.client.send = async (command, options) => {
    if (command.constructor.name !== 'PutObjectCommand') return send(command, options);
    copies.push(Buffer.from(command.input.Body)); return {};
  };
  const bytes = randomBytes(2 * 1048576 + 7);
  const ref = await service.put(scope, 'job', 'attempt/1/video', bytes);
  await service.put(scope, 'job', 'attempt/1/video', bytes);
  assert.notDeepEqual(copies[0], copies[1], 'equivalent originals may have different encryption nonces');
  state.versions.set(candidate, copies[0]); state.versions.set(current, copies[1]); state.length = copies[0].length;
  return { state, service, ref, bytes, config };
}

module.exports = { fixture, scope, candidate, current };

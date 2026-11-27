require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createCipheriv } = require('node:crypto');
const { fixture, scope, candidate, current } = require('./testing/private-version-http.cjs');

test('verifies exact noncurrent/current versions over S3 HTTP without buffering or mutation', async t => {
  const f = await fixture(t);
  const result = await f.service.verifyVersionCopies(scope, f.ref, candidate);
  assert.deepEqual(result, { key: f.ref.key, retainedVersion: current, candidateVersion: candidate,
    plaintextBytes: f.bytes.length, storedBytes: f.bytes.length + 36, sha256: f.ref.sha256 });
  assert.deepEqual(f.state.requests, [{ method: 'HEAD', version: null }, { method: 'GET', version: current },
    { method: 'GET', version: candidate }, { method: 'HEAD', version: null }]);
  assert.equal(f.state.peak, 1, 'version reads are sequential');
});

test('rejects invalid or unversioned candidates before storage IO', async t => {
  const f = await fixture(t);
  for (const version of [undefined, null, '', 'null', '\0version', 'v'.repeat(1025)])
    await assert.rejects(f.service.verifyVersionCopies(scope, f.ref, version), { status: 400 });
  await assert.rejects(f.service.verifyVersionCopies({ ...scope, contract: 'ct_other' }, f.ref, candidate), { status: 400 });
  assert.equal(f.state.requests.length, 0);
});

for (const scenario of ['current-candidate', 'null-current', 'current-marker', 'wrong-echo', 'missing-echo', 'candidate-marker', 'head-size', 'get-size', 'corrupt-old', 'corrupt-current', 'changed-current', 'missing-version', 'wrong-hash']) {
  test(`version verification rejects ${scenario}`, async t => {
    const f = await fixture(t), s = f.state;
    let version = candidate;
    if (scenario === 'current-candidate') version = current;
    if (scenario === 'null-current') s.current = 'null';
    if (scenario === 'current-marker') s.currentMarker = true;
    if (scenario === 'wrong-echo') s.wrongEcho = true;
    if (scenario === 'missing-echo') s.omitEcho = true;
    if (scenario === 'candidate-marker') s.marker = true;
    if (scenario === 'head-size') s.badHeadSize = true;
    if (scenario === 'get-size') s.badGetSize = true;
    if (scenario === 'corrupt-old') s.versions.get(candidate)[40] ^= 1;
    if (scenario === 'corrupt-current') s.versions.get(current)[40] ^= 1;
    if (scenario === 'changed-current') s.changeCurrent = true;
    if (scenario === 'missing-version') s.versions.delete(candidate);
    if (scenario === 'wrong-hash') {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', f.config.keys.key1, iv);
      cipher.setAAD(f.service.aad(f.ref));
      const encrypted = Buffer.concat([cipher.update(Buffer.alloc(f.bytes.length)), cipher.final()]);
      s.versions.set(candidate, Buffer.concat([Buffer.from('SHPRIV01'), iv, cipher.getAuthTag(), encrypted]));
    }
    await assert.rejects(f.service.verifyVersionCopies(scope, f.ref, version), { status: 503 });
    assert.ok(s.requests.every(request => ['HEAD', 'GET'].includes(request.method)));
  });
}

test('cancellation closes the version stream and yields no verification result', async t => {
  const f = await fixture(t), abort = new AbortController();
  f.state.hang = true; f.state.onHang = () => abort.abort();
  await assert.rejects(f.service.verifyVersionCopies(scope, f.ref, candidate, abort.signal), { status: 503 });
  assert.equal(f.state.heads, 1);
  assert.equal(f.state.reads, 2);
});

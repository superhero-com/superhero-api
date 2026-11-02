require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ShortsUploadPolicyService, shortsUploadPolicyConfig } = require('./shorts-upload-policy.service');
const { shortsSourceLimit, shortsAcceptedSource } = require('./shorts-upload-policy');
const { ShortsUploadRecordsService } = require('./shorts-upload-records.service');
const { ShortsHostedUploadsService } = require('./shorts-hosted-uploads.service');
const { releaseFixture } = require('./shorts-release.fixture.cjs');
const policy = { maxVideoBytes: 100000000 };
const input = { bytes: 100000000, sha256: 'a'.repeat(64), title: 'Original', topic: 'Art', rights: true, details: {} };
const enabled = (maxOriginalBytes = 100000000) => new ShortsUploadPolicyService({ originals: true, maxOriginalBytes });

test('original admission is opt-in, bounded by both operator and active contract limits', () => {
  const defaults = new ShortsUploadPolicyService(shortsUploadPolicyConfig({}));
  assert.equal(defaults.describe(policy, true).maxBytes, 40 * 1048576);
  assert.equal(defaults.describe(policy, true).format, 'legacy-directory-v1');
  assert.throws(() => defaults.accept(input, policy), { status: 400 });
  const upload = enabled().accept(input, policy);
  assert.equal(upload.processingProfile, 'original-h264-v1');
  assert.equal(upload.acceptedMaxBytes, input.bytes);
  assert.equal(enabled(50000000).describe(policy, true).maxBytes, 50000000);
  assert.equal(enabled().describe({ maxVideoBytes: 30000000 }, true).maxBytes, 30000000);
  assert.throws(() => enabled().accept({ ...input, bytes: 100000001 }, policy), { status: 400 });
  assert.throws(() => enabled().describe(policy, false), /shared hosted/);
  for (const value of ['0', '100000001', '256000000', '1e8', '100000000.0', ' 123'])
    assert.throws(() => shortsUploadPolicyConfig({ SHORTS_ORIGINAL_UPLOAD_MAX_BYTES: value }));
  assert.throws(() => shortsUploadPolicyConfig({ SHORTS_ORIGINAL_UPLOADS_ENABLED: '1' }));
});

test('caller fields cannot enable a writer; accepted profile and limit survive later configuration changes', () => {
  const malicious = { ...input, bytes: 100, processingProfile: 'original-h264-v1', acceptedMaxBytes: 256000000, objectKey: 'private/source', manifest: { key: 'secret' } };
  const legacy = new ShortsUploadPolicyService(shortsUploadPolicyConfig({})).accept(malicious, policy);
  assert.equal(legacy.processingProfile, undefined);
  assert.throws(() => new ShortsUploadPolicyService(shortsUploadPolicyConfig({})).accept({ ...malicious, expectedFormat: 'original-file-v1' }, policy), { status: 409 });
  assert.equal(legacy.objectKey, undefined); assert.equal(legacy.manifest, undefined);
  const accepted = enabled(70000000).accept({ ...malicious, bytes: 70000000 }, policy);
  const source = shortsAcceptedSource(accepted);
  assert.deepEqual(source, { bytes: 70000000, sha256: input.sha256, maxBytes: 70000000, format: 'original-file-v1' });
  assert.equal(shortsSourceLimit(accepted), 70000000);
  assert.equal(enabled(10000000).describe(policy, true).maxBytes, 10000000);
  assert.equal(shortsSourceLimit(accepted), 70000000, 'readers do not consult current flags');
  const records = new ShortsUploadRecordsService({}, {});
  records.validateInput(accepted);
  for (const changed of [{ bytes: 70000001 }, { processingProfile: undefined }, { acceptedMaxBytes: 100000001 }, { processingProfile: 'unknown' }])
    assert.throws(() => records.validateInput({ ...accepted, ...changed }), { status: 400 });
});

test('hosted creation and status share the server-selected capability and expose only source identity', async () => {
  const { release } = releaseFixture();
  const chain = { release, state: { contract: release.contract }, address() {}, policy: async () => policy };
  let saved;
  const uploads = { create: async (_scope, id, creator, accepted) => (saved = { id, creator, input: accepted, parts: [], state: 'uploading', expiresAt: Date.now() + 60000 }) };
  const service = new ShortsHostedUploadsService({ shared: true, chain }, {}, uploads, { assertDirectUploadsConfigured() {} }, enabled());
  const session = await service.create('ak_owner', input);
  assert.equal(saved.input.processingProfile, 'original-h264-v1');
  assert.equal(session.source.bytes, 100000000);
  assert.equal(session.source.format, 'original-file-v1');
  assert.equal(session.partSize, 1048576);
  assert.equal(session.transport, 'direct-s3-v1');
  assert.equal(session.input, undefined);
  chain.policy = async () => { chain.state.contract = 'ct_changed'; return policy; };
  await assert.rejects(service.create('ak_owner', input));
});

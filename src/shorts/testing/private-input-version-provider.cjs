const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { ShortsPrivateObjectsService } = require('../shorts-private-objects.service');
const { ShortsPrivateVersionStorageService } = require('../shorts-private-version-storage.service');
const { ShortsPrivateInputVersionStorageService } = require('../shorts-private-input-version-storage.service');

// Real provider transport qualification. Durability authority is deliberately a
// test callback here; the API/database coordinator must supply it in production.
module.exports = async f => {
  const { t, rootConfig, raw, writer, sts, AssumeRoleCommand, plaintext, scope, keys, intact } = f;
  await t.test('authenticated retirement removes current and final versions with exact-version STS permissions', async () => {
    let ciphertext, ref;
    const versions = [], write = writer.client.send;
    writer.client.send = async command => { assert.equal(command.constructor.name, 'PutObjectCommand'); ciphertext = Buffer.from(command.input.Body); return {}; };
    try {
      for (let i = 0; i < 2; i++) {
        ref = await writer.put(scope, 'retired-input', 'attempt/1/video', plaintext);
        const result = await raw.send(new PutObjectCommand({ Bucket: rootConfig.bucket, Key: ref.key, Body: ciphertext }));
        assert.ok(result.VersionId && result.VersionId !== 'null'); versions.push(result.VersionId);
      }
    } finally { writer.client.send = write; }
    const bucketArn = `arn:aws:s3:::${rootConfig.bucket}`, objectPrefix = ref.key.split('/').slice(0, 2).join('/') + '/';
    const policy = { Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Action: ['s3:GetBucketVersioning', 's3:GetLifecycleConfiguration'], Resource: [bucketArn] },
      { Effect: 'Allow', Action: ['s3:ListBucket', 's3:ListBucketVersions'], Resource: [bucketArn],
        Condition: { StringLike: { 's3:prefix': [objectPrefix + '*'] } } },
      { Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion'], Resource: [bucketArn + '/' + ref.key] },
      { Effect: 'Allow', Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'], Resource: [bucketArn + '/' + ref.key],
        Condition: { StringEquals: { 's3:versionid': versions } } },
    ] };
    const issued = await sts.send(new AssumeRoleCommand({ RoleArn: 'arn:aws:iam::123456789012:role/shorts-retired-input',
      RoleSessionName: 'retired-input-' + randomUUID(), DurationSeconds: 900, Policy: JSON.stringify(policy) }));
    const credentials = { accessKeyId: issued.Credentials.AccessKeyId, secretAccessKey: issued.Credentials.SecretAccessKey, sessionToken: issued.Credentials.SessionToken };
    const config = { objectPrefix, storage: { ...rootConfig, credentials } },
      objects = new ShortsPrivateObjectsService({ ...rootConfig, credentials, activeKeyId: 'key1', keys }),
      storage = new ShortsPrivateVersionStorageService(config), limited = new S3Client(config.storage),
      io = new ShortsPrivateInputVersionStorageService(objects, storage), signal = new AbortController().signal;
    const [older, latest] = versions;
    let grants = 0, checks = 0;
    const authority = async (scope, ref, version) => { grants++; return { scope, ref, version, issuedAt: new Date(), assertCurrent: async () => { checks++; } }; };
    try {
      for (const command of [new DeleteObjectCommand({ Bucket: rootConfig.bucket, Key: ref.key }),
        new DeleteObjectCommand({ Bucket: rootConfig.bucket, Key: ref.key, VersionId: 'null' }),
        new DeleteObjectCommand({ Bucket: rootConfig.bucket, Key: f.ref.key, VersionId: latest }),
        new PutObjectCommand({ Bucket: rootConfig.bucket, Key: ref.key, Body: 'forbidden' })])
        await assert.rejects(limited.send(command), error => error.$metadata?.httpStatusCode === 403);
      const expired = await getSignedUrl(limited, new DeleteObjectCommand({ Bucket: rootConfig.bucket, Key: ref.key, VersionId: latest }),
        { expiresIn: 30, signingDate: new Date(Date.now() - 60000) });
      const response = await fetch(expired, { method: 'DELETE', redirect: 'error', credentials: 'omit' });
      assert.equal(response.status, 403); await response.body?.cancel();
      await objects.verifyStoredVersion(scope, ref, latest, signal);
      assert.deepEqual(await io.remove(scope, ref, latest, signal, authority), { key: ref.key, version: latest, removed: true });
      assert.equal((await raw.send(new HeadObjectCommand({ Bucket: rootConfig.bucket, Key: ref.key }))).VersionId, older);
      assert.deepEqual(await objects.get(scope, ref), plaintext); await intact();
      const originalFetch = global.fetch; let deletes = 0;
      global.fetch = async (url, options) => {
        const result = await originalFetch(url, options);
        if (options?.method === 'DELETE' && new URL(url).searchParams.get('versionId') === older) {
          assert.equal(result.status, 204); await result.body?.cancel(); deletes++; throw new Error('lost retired-version acknowledgement');
        }
        return result;
      };
      try { await assert.rejects(io.remove(scope, ref, older, signal, authority), /lost retired-version/); }
      finally { global.fetch = originalFetch; }
      assert.equal(deletes, 1); assert.equal(grants, 2); assert.equal(checks, 2);
      const restarted = new ShortsPrivateInputVersionStorageService(objects, storage);
      assert.equal(await restarted.absent(scope, ref, older, signal), true);
      assert.equal(await restarted.absent(scope, ref, latest, signal), true);
      await assert.rejects(raw.send(new HeadObjectCommand({ Bucket: rootConfig.bucket, Key: ref.key })), error => error.$metadata?.httpStatusCode === 404);
      await intact();
      const late = await raw.send(new PutObjectCommand({ Bucket: rootConfig.bucket, Key: ref.key, Body: ciphertext }));
      assert.equal(await restarted.absent(scope, ref, latest, signal), true);
      assert.equal(await restarted.absent(scope, ref, late.VersionId, signal), false);
      await assert.rejects(restarted.remove(scope, ref, late.VersionId, signal, authority), /uncertain/);
      assert.equal((await raw.send(new HeadObjectCommand({ Bucket: rootConfig.bucket, Key: ref.key }))).VersionId, late.VersionId);
      await intact();
    } finally { objects.onModuleDestroy(); storage.onModuleDestroy(); limited.destroy(); }
  });
};

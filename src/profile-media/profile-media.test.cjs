const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, webcrypto } = require('node:crypto');
const { Readable } = require('node:stream');
require('reflect-metadata');
const { DataSource } = require('typeorm');
const { Test } = require('@nestjs/testing');
const { Module, Global, ValidationPipe } = require('@nestjs/common');
const { AccountMemory } = require('@aeternity/aepp-sdk');
const request = require('supertest');
const sharp = require('sharp');
const { ProfileMedia1792954800000 } = require('../migrations/1792954800000-ProfileMedia');
const { PostImages1793012400000 } = require('../migrations/1793012400000-PostImages');
const { ProfileMediaCleanup1793008800000 } = require('../migrations/1793008800000-ProfileMediaCleanup');
const { ProfileMediaModule } = require('./profile-media.module');
const { ProfileMediaChain } = require('./profile-media-chain.service');
const { profileImageHash } = require('./profile-media-storage.service');
const { ProfileMediaAuth } = require('./profile-media-auth.service');
const { ProfileMediaEncoder } = require('./profile-media-encoder.service');
const { ProfileMediaDatabase } = require('./profile-media-database.service');
const { ProfileMediaUploads, PROFILE_MEDIA_OBJECTS } = require('./profile-media-uploads.service');
const { ProfileMediaWorker } = require('./profile-media-worker.service');
const { ProfileMediaAssets } = require('./profile-media-assets.service');
const { ProfileMediaEdgeController } = require('./profile-media-edge.controller');
const { ProfileMediaGate } = require('./profile-media.controller');
const { imageReference, profileImageReference } = require('./image-reference');
const { verifyAeAddressSignature } = require('../profile/services/profile-signature.util');
const { PROFILE_MEDIA_CONFIG } = require('./profile-media.config');
const { ShortsPrivateObjectsService } = require('../shorts/shorts-private-objects.service');

const url = process.env.PROFILE_MEDIA_TEST_DATABASE_URL;
const alice = AccountMemory.generate(), bob = AccountMemory.generate();
const config = { enabled: true, maxStoredBytes: 268435456, scope: 'profile-media-test', network: 'ae_uat', contract: 'ct_test',
  origin: 'https://profiles.example', publicUrl: 'https://profiles.example/profile-images' };
let source, app, edge, worker, db, schema, png, token, otherToken, getCount = 0;
const assets = new Map(), links = new Map(), writes = new Map(), encrypted = new Map();
let settled = false;
const chain = { providerAddress: alice.address, ensureProviders: async () => ({}),
  links: async (address) => links.get(address) || {}, nonce: async () => 0,
  message: (...args) => new ProfileMediaChain({enabled:false}).message(...args),
  submit: async (address, role, nonce, cid, signature, journal) => {
    assert.ok(!cid || !cid.includes(':'), 'Deployed AddressLink values cannot contain colons');
    assert.ok(verifyAeAddressSignature(address, cid ? `link:${address}:${role}:${cid}:${nonce}` : `unlink:${address}:${role}:${nonce}`, signature));
    const hash = `th_${randomBytes(12).toString('hex')}`;
    await journal('tx_test', hash); writes.set(hash, { address, role, cid });
  }, expired: async () => false, rebroadcast: async () => {},
  transaction: async (hash) => {
    if (!settled) return 'pending';
    const row = writes.get(hash);
    links.set(row.address, { ...links.get(row.address), [row.role]: row.cid });
    return 'confirmed';
  } };
const storage = {
  prepare: async (files) => ({ cid: `bafy${profileImageHash(Buffer.concat(files.map((f) => f.data))).slice(0,55).replace(/[0189]/g,'a')}`,
    files: files.map((file) => ({ name: file.name, bytes: file.data.length, sha256: profileImageHash(file.data) })) }),
  pin: async (files) => { const result = await storage.prepare(files); assets.set(result.cid, files); return result; },
  read: async (cid, file) => assets.get(cid).find((row) => row.name === file.name).data,
};
const objects = new ShortsPrivateObjectsService({ endpoint: 'https://internal.example.com', uploadEndpoint: 'https://uploads.example.com',
  region: 'us-east-1', bucket: 'private-images', prefix: 'private', forcePathStyle: true,
  credentials: { accessKeyId: 'only-test', secretAccessKey: 'not-a-real-credential' },
  activeKeyId: 'v1', keys: { v1: randomBytes(32) } });
objects.client.send = async command => {
  const bytes = encrypted.get(command.input.Key);
  if (!bytes) throw new Error('Object missing');
  if (command.constructor.name === 'HeadObjectCommand') return { ContentLength: bytes.length, ChecksumSHA256: Buffer.from(profileImageHash(bytes), 'hex').toString('base64') };
  assert.equal(command.constructor.name, 'GetObjectCommand'); getCount++;
  return { ContentLength: bytes.length, Body: Readable.from([bytes]) };
};
before(async () => {
  if (!url) return;
  const parsed = new URL(url);
  assert.equal(parsed.hostname, '127.0.0.1'); assert.match(parsed.pathname, /_test$/);
  schema = `profile_media_${randomBytes(6).toString('hex')}`;
  source = new DataSource({ type: 'postgres', url, extra: { options: `-c search_path=${schema}` } });
  await source.initialize(); await source.query(`CREATE SCHEMA ${schema}`);
  const runner = source.createQueryRunner(); await runner.connect();
  await new ProfileMedia1792954800000().up(runner);
  await new ProfileMediaCleanup1793008800000().up(runner);
  await new PostImages1793012400000().up(runner); await runner.release();
  class TestDatabaseModule {}
  Global()(TestDatabaseModule);
  Module({ providers: [{ provide: DataSource, useValue: source }], exports: [DataSource] })(TestDatabaseModule);
  const module = await Test.createTestingModule({ imports: [TestDatabaseModule, ProfileMediaModule] })
    .overrideProvider(PROFILE_MEDIA_CONFIG).useValue(config)
    .overrideProvider(ProfileMediaChain).useValue(chain)
    .overrideProvider(PROFILE_MEDIA_OBJECTS).useValue(objects).compile();
  app = module.createNestApplication(); app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.init();
  db = app.get(ProfileMediaDatabase);
  const processor = new ProfileMediaAssets(db, storage, new ProfileMediaEncoder(), config);
  worker = new ProfileMediaWorker(db, app.get(ProfileMediaAuth), app.get(ProfileMediaUploads), processor);
  const edgeModule = await Test.createTestingModule({ controllers: [ProfileMediaEdgeController], providers: [ProfileMediaGate,
    { provide: ProfileMediaAssets, useValue: processor }, { provide: ProfileMediaDatabase, useValue: { query: (...args) => db.query(...args) } },
    { provide: ProfileMediaAuth, useValue: app.get(ProfileMediaAuth) }, { provide: PROFILE_MEDIA_CONFIG, useValue: config } ] }).compile();
  edge = edgeModule.createNestApplication(); await edge.init();
  png = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#08ab99' } }).png().toBuffer();
});
after(async () => { if (edge) await edge.close(); if (app) await app.close(); objects.onModuleDestroy(); if (source) { await source.query(`DROP SCHEMA ${schema} CASCADE`); await source.destroy(); } });
const api = () => request(app.getHttpServer());
const images = () => request(edge.getHttpServer());
const path = '/api/profile-media';
const post = (route, data, session = token) => api().post(`${path}${route}`).set('Authorization', `Bearer ${session}`).send(data);
async function login(wallet) {
  const challenge = await api().post(`${path}/auth/challenge`).send({ address: wallet.address }).expect(201);
  const signature = Buffer.from(await wallet.signMessage(challenge.body.message)).toString('hex');
  const verified = await api().post(`${path}/auth/verify`).send({ id: challenge.body.id, signature }).expect(201);
  await api().post(`${path}/auth/verify`).send({ id: challenge.body.id, signature }).expect(401);
  return verified.body.token;
}
async function upload(input, role = 'avatar', session = token, declaredHash = profileImageHash(input)) {
  const created = await post('/uploads', { role, bytes: input.length, sha256: declaredHash }, session).expect(201);
  const id = created.body.id;
  await api().get(`${path}/uploads/${id}`).set('Authorization', `Bearer ${otherToken}`).expect(404);
  await post(`/uploads/${id}/finish`, {}, session).expect(400);
  for (let index = 0; index < Math.ceil(input.length / created.body.partSize); index++) {
    const part = input.subarray(index * created.body.partSize, (index + 1) * created.body.partSize);
    const route = `/uploads/${id}/parts/${index}`;
    const prepared = await post(`${route}/prepare`, { sha256: profileImageHash(part) }, session).expect(201);
    const descriptor = prepared.body;
    const key = await webcrypto.subtle.importKey('raw', Buffer.from(descriptor.key, 'hex'), 'AES-GCM', false, ['encrypt']);
    const cipher = Buffer.from(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: Buffer.from(descriptor.iv, 'hex'), additionalData: Buffer.from(descriptor.aad, 'base64'), tagLength: 128 }, key, part));
    const body = Buffer.concat([Buffer.from('SHPRIV02'), Buffer.from(descriptor.iv, 'hex'), cipher.subarray(-16), cipher.subarray(0, -16)]);
    const permission = await post(`${route}/authorize`, { checksum: profileImageHash(body) }, session).expect(201);
    const destination = new URL(permission.body.url);
    assert.equal(destination.origin, 'https://uploads.example.com');
    assert.equal(permission.body.headers.Authorization, undefined);
    assert.equal(permission.body.headers['if-none-match'], '*');
    await post(`${route}/complete`, {}, session).expect(400);
    encrypted.set(decodeURIComponent(destination.pathname.replace('/private-images/', '')), body);
    await post(`${route}/complete`, {}, session).expect(201);
    await post(`${route}/complete`, {}, session).expect(201);
  }
  await post(`/uploads/${id}/finish`, {}, session).expect(201);
  return id;
}
const status = id => api().get(`${path}/uploads/${id}`).set('Authorization', `Bearer ${token}`).expect(200);

test('decoder strips metadata, enforces dimensions and rejects SVG, malformed and oversized inputs', async () => {
  const encoder = new ProfileMediaEncoder();
  const input = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#abc' } }).withMetadata().png().toBuffer();
  const result = await encoder.encode(input, 'avatar');
  const metadata = await sharp(result.image).metadata();
  assert.equal(metadata.width, metadata.height); assert.equal(metadata.format, 'webp'); assert.equal(metadata.exif, undefined);
  assert.ok(result.image.length < input.length);
  const cover = await encoder.encode(input, 'cover'); assert.ok(Math.abs(cover.width / cover.height - 8 / 3) < 0.01);
  for (const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), input.subarray(0,80), Buffer.alloc(10485761)])
    await assert.rejects(encoder.encode(bytes, 'avatar'));
  const tiny = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#000' } }).png().toBuffer();
  await assert.rejects(encoder.encode(tiny, 'cover'));
});

test('JSON control plane uses HEAD only; separate worker compresses and edge serves after wallet confirmation', { skip: !url }, async () => {
  token = await login(alice); otherToken = await login(bob);
  await api().post(`${path}/upload/avatar`).set('Authorization', `Bearer ${token}`).attach('file', png, 'avatar.png').expect(404);
  await api().post(`${path}/uploads`).set('Authorization', `Bearer ${token}`).attach('file', png, 'avatar.png').expect(400);
  const id = await upload(png);
  assert.equal(getCount, 0, 'API never downloads image blobs');
  assert.equal((await status(id)).body.status, 'queued');
  await worker.process();
  const completed = (await status(id)).body;
  assert.equal(completed.status, 'ready'); assert.equal(getCount, 1);
  const cid = completed.cid;
  await api().get(`${path}/images/${cid}/image.webp`).expect(404);
  await images().get(`/profile-images/images/${cid}/image.webp`).expect(404);
  await post('/claim', { role: 'avatar', cid }, otherToken).expect(400);
  const claim = await post('/claim', { role: 'avatar', cid }).expect(201);
  const wrong = Buffer.from(await bob.signMessage(claim.body.message)).toString('hex');
  await post('/submit', { id: claim.body.id, signature: wrong }).expect(400);
  const signature = Buffer.from(await alice.signMessage(claim.body.message)).toString('hex');
  const write = await post('/submit', { id: claim.body.id, signature }).expect(201);
  assert.equal(write.body.status, 'submitted');
  await post('/submit', { id: claim.body.id, signature }).expect(201);
  assert.equal(writes.size, 1, 'retry must not sign a second transaction');
  await api().get(`${path}/writes/${claim.body.id}`).set('Authorization', `Bearer ${otherToken}`).expect(404);
  settled = true;
  const confirmed = await api().get(`${path}/writes/${claim.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
  assert.equal(confirmed.body.status, 'confirmed');
  const batch = await api().get(`${path}/batch`).query({ addresses: alice.address }).expect(200);
  assert.equal(batch.body[0].avatar_cid, cid);
  assert.equal(batch.body[0].avatar_ref, imageReference(cid));
  assert.equal(batch.body[0].avatar_preview_ref, imageReference(cid,true));
  assert.equal(links.get(alice.address).avatar,profileImageReference(cid));
  assert.equal(batch.body[0].avatarurl, `${config.publicUrl}/images/${cid}/image.webp`);
  const image = await images().get(`/profile-images/images/${cid}/image.webp`).expect(200);
  assert.equal(image.headers['content-type'], 'image/webp');
  assert.equal((await sharp(image.body).metadata()).format, 'webp');
  await images().get(`/profile-images/images/${cid}/manifest.json`).expect(404);
  await api().post(`${path}/reports`).expect(404);
  const remove = await post('/claim', { role: 'avatar', cid: null }).expect(201);
  assert.match(remove.body.message, /^unlink:/);
});

test('multi-part source resumes after a worker lease expires; invalid bytes never become claimable', { skip: !url }, async () => {
  const input = await sharp(randomBytes(1024 * 512 * 3), { raw: { width: 1024, height: 512, channels: 3 } }).png().toBuffer();
  const id = await upload(input, 'cover');
  await db.query("UPDATE profile_media_uploads SET state='processing',lease_until=now()-interval '1 second',attempts=1 WHERE id=$1", [id]);
  await worker.process();
  const complete = (await status(id)).body; assert.equal(complete.status, 'ready');
  const metadata = await sharp(assets.get(complete.cid)[0].data).metadata();
  assert.ok(Math.abs(metadata.width / metadata.height - 8 / 3) < 0.01);
  const bad = await upload(Buffer.from('<svg/>'));
  await worker.process(); assert.equal((await status(bad)).body.status, 'failed');
  const mismatch = await upload(png, 'avatar', token, 'a'.repeat(64));
  await worker.process(); await worker.process(); await worker.process();
  assert.equal((await status(mismatch)).body.status, 'failed');
});

test('shared admission and storage reservations are atomic and bounded', { skip: !url }, async () => {
  const auth = app.get(ProfileMediaAuth);
  const outcomes = await Promise.allSettled([auth.acquireUpload(), auth.acquireUpload(), auth.acquireUpload()]);
  assert.equal(outcomes.filter((row) => row.status === 'fulfilled').length, 2);
  for (const row of outcomes) if (row.status === 'fulfilled') await auth.releaseUpload(row.value);
  const lease = await auth.acquireUpload(); await auth.releaseUpload(lease);
  const rates = await Promise.allSettled(Array.from({ length: 5 }, () => auth.rate('test-rate', 2, 60)));
  assert.equal(rates.filter((row) => row.status === 'fulfilled').length, 2);
  const oldBudget = config.maxStoredBytes; config.maxStoredBytes = 2;
  try { await post('/uploads', { role: 'avatar', bytes: png.length, sha256: profileImageHash(png) }).expect(503); }
  finally { config.maxStoredBytes = oldBudget; }
});

test('testnet deployment records signed bytes before broadcast and resumes the same deployment', async () => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const { ProfileMediaOperations } = require('./profile-media-operations.module');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-setup-'));
  const previous = { artifact: process.env.PROFILE_MEDIA_DEPLOY_ARTIFACT, journal: process.env.PROFILE_MEDIA_DEPLOY_JOURNAL_FILE };
  const artifact = path.join(directory, 'artifact.json'), journal = path.join(directory, 'journal.json');
  let deployments = 0, rebroadcasts = 0;
  const operations = new ProfileMediaOperations({ config: { enabled: true, network: 'ae_uat' }, providerAddress: alice.address,
    deploy: async (_code, persist) => { deployments++; await persist({ address: 'ct_created', txHash: 'th_created', signedTx: 'tx_same' }); throw new Error('Lost broadcast response'); },
    rebroadcast: async tx => { assert.equal(tx, 'tx_same'); rebroadcasts++; },
  });
  try {
    await fs.writeFile(artifact, JSON.stringify({ bytecode: 'cb_fixture', aci: require('../plugins/address-links/aci/AddressLink.aci.json') }));
    process.env.PROFILE_MEDIA_DEPLOY_ARTIFACT = artifact; process.env.PROFILE_MEDIA_DEPLOY_JOURNAL_FILE = journal;
    await assert.rejects(operations.deploy(), /Lost broadcast/);
    assert.equal((await fs.stat(journal)).mode & 0o777, 0o600);
    const result = await operations.deploy();
    assert.equal(result.address, 'ct_created'); assert.equal(result.signedTx, undefined);
    assert.equal(deployments, 1); assert.equal(rebroadcasts, 1);
    const changed = JSON.parse(await fs.readFile(artifact)); changed.bytecode = 'cb_changed'; await fs.writeFile(artifact, JSON.stringify(changed));
    await assert.rejects(operations.deploy(), /different artifact/); assert.equal(rebroadcasts, 1);
  } finally {
    if (previous.artifact === undefined) delete process.env.PROFILE_MEDIA_DEPLOY_ARTIFACT; else process.env.PROFILE_MEDIA_DEPLOY_ARTIFACT = previous.artifact;
    if (previous.journal === undefined) delete process.env.PROFILE_MEDIA_DEPLOY_JOURNAL_FILE; else process.env.PROFILE_MEDIA_DEPLOY_JOURNAL_FILE = previous.journal;
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test('four direct-uploaded post images preserve aspect ratio, enforce ownership and become durable before publishing', { skip: !url }, async () => {
  await db.query('DELETE FROM profile_media_rates WHERE scope=$1', [config.scope]);
  const challenge = await api().post(`${path}/auth/challenge`).send({address: alice.address, purpose: 'post'}).expect(201);
  assert.match(challenge.body.message, /^Superhero post images\n/);
  assert.match(challenge.body.message, /Publishing a post requires a separate signature/);
  const signed = Buffer.from(await alice.signMessage(challenge.body.message)).toString('hex');
  const verified = await api().post(`${path}/auth/verify`).send({id:challenge.body.id,signature:signed}).expect(201);
  const session = verified.body.token, cids = [];
  for (let i = 0; i < 4; i++) {
    const input = await sharp({create:{width:1200+i*100,height:800,channels:3,background:'#26a576'}}).withExif({ IFD0: { Artist: 'Must be stripped' } }).jpeg().toBuffer();
    const id = await upload(input, 'post', session);
    await worker.process();
    const result = (await status(id)).body;
    assert.equal(result.status,'ready'); cids.push(result.cid);
    const image = await images().get(`/profile-images/images/${result.cid}/image.webp`).expect(200);
    const meta = await sharp(image.body).metadata();
    assert.equal(meta.width,1200+i*100); assert.equal(meta.height,800); assert.equal(meta.exif,undefined);
    await post('/claim',{role:'avatar',cid:result.cid},session).expect(400);
  }
  await post('/attachments',{cids},otherToken).expect(400);
  await post('/attachments',{cids:[...cids,cids[0]]},session).expect(400);
  await post('/attachments',{cids:[cids[0],cids[0]]},session).expect(400);
  await post('/claim',{role:'post',cid:cids[0]},session).expect(400);
  const result = await post('/attachments',{cids:[...cids].reverse()},session).expect(201);
  assert.deepEqual(result.body.media,[...cids].reverse().map(cid=>imageReference(cid)));
  assert.deepEqual(result.body.previews,[...cids].reverse().map(cid=>imageReference(cid,true)));
  await post('/attachments',{cids},session).expect(201); // Retries are idempotent.
  await db.query("UPDATE profile_media_assets SET created_at=now()-interval '3 days',replaced_at=now()-interval '2 days' WHERE cid=ANY($1)",[cids]);
  const {ProfileMediaRetention}=require('./profile-media-retention.service');
  await new ProfileMediaRetention(db,chain,config).process();
  const rows=await db.query('SELECT ready,last_linked_at,cleanup_requested_at FROM profile_media_assets WHERE cid=ANY($1)',[cids]);
  assert.equal(rows.length,4); assert.ok(rows.every(row=>row.ready && row.last_linked_at && !row.cleanup_requested_at));
});

test('post encoding bounds large images without cropping or enlarging them', async () => {
  const encoder = new ProfileMediaEncoder();
  for (const [width,height,expected] of [[4096,2048,[2048,1024]],[400,800,[400,800]],[2048,4096,[1024,2048]]]) {
    const input=await sharp({create:{width,height,channels:3,background:'#7ab'}}).png().toBuffer();
    const result=await encoder.encode(input,'post');
    assert.deepEqual([result.width,result.height],expected);
    const thumb=await sharp(result.thumb).metadata();
    assert.ok(thumb.width<=640 && thumb.height<=640);
  }
  await assert.rejects(encoder.encode(Buffer.from('<svg/>'),'post'));
});

test('detailed photos retain a large display image and a bounded small preview for every role', async () => {
  const encoder = new ProfileMediaEncoder();
  const input = await sharp(randomBytes(2048 * 2048 * 3), { raw: { width: 2048, height: 2048, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
  for (const [role, dimensions] of [['post',[2048,2048]],['avatar',[1024,1024]],['cover',[1920,720]]]) {
    const result = await encoder.encode(input, role);
    assert.deepEqual([result.width,result.height],dimensions);
    assert.ok(result.thumb.length <= 48 * 1024);
    assert.ok(result.thumb.length < result.image.length / 4);
    assert.equal((await sharp(result.thumb).metadata()).exif, undefined);
  }
});


test('avatar and cover claims sign underscore values and expose colon-based API references', { skip: !url }, async () => {
  for (const role of ['avatar','cover']) {
    const id = await upload(png, role);
    await worker.process();
    const cid = (await status(id)).body.cid;
    const claim = await post('/claim', { role, cid }).expect(201);
    const message = `link:${alice.address}:${role}:ipfs_superhero_images_${cid}:${claim.body.nonce}`;
    assert.equal(claim.body.message, message);
    assert.equal(claim.body.value, profileImageReference(cid));
    assert.equal(claim.body.reference, imageReference(cid));
    const signature = Buffer.from(await alice.signMessage(message)).toString('hex');
    const result = await post('/submit', { id: claim.body.id, signature }).expect(201);
    assert.equal(result.body.status, 'confirmed');
    assert.equal(links.get(alice.address)[role], profileImageReference(cid));
    const [images] = (await api().get(`${path}/batch?addresses=${alice.address}`).expect(200)).body;
    assert.equal(images[role+'_ref'], imageReference(cid));
    assert.equal(images[role+'_preview_ref'], imageReference(cid,true));
  }
});

test('a bare-CID signature prepared before the underscore upgrade is submitted unchanged', { skip: !url }, async () => {
  const id = await upload(png, 'avatar');
  await worker.process();
  const cid = (await status(id)).body.cid;
  const claim = await post('/claim', { role: 'avatar', cid }).expect(201);
  const message = `link:${alice.address}:avatar:${cid}:${claim.body.nonce}`;
  await db.query('UPDATE profile_media_writes SET message=$2 WHERE id=$1', [claim.body.id,message]);
  const signature = Buffer.from(await alice.signMessage(message)).toString('hex');
  const result = await post('/submit', { id: claim.body.id, signature }).expect(201);
  assert.equal(result.body.status, 'confirmed');
  assert.equal(links.get(alice.address).avatar, cid);
});

test('a signature prepared with a namespace unsupported by the identity contract must be reviewed again', { skip: !url }, async () => {
  const id = await upload(png, 'avatar');
  await worker.process();
  const cid = (await status(id)).body.cid;
  const claim = await post('/claim', { role: 'avatar', cid }).expect(201);
  const message = `link:${alice.address}:avatar:${imageReference(cid)}:${claim.body.nonce}`;
  await db.query('UPDATE profile_media_writes SET message=$2 WHERE id=$1', [claim.body.id, message]);
  const signature = Buffer.from(await alice.signMessage(message)).toString('hex');
  const result = await post('/submit', { id: claim.body.id, signature }).expect(409);
  assert.match(result.body.message, /review and sign again/);
  const state = await api().get(`${path}/writes/${claim.body.id}/status?address=${alice.address}`).expect(200);
  assert.equal(state.body.status, 'failed');
});

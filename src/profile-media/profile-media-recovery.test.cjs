const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { UnauthorizedException } = require('@nestjs/common');
const { AccountMemory } = require('@aeternity/aepp-sdk');
const request = require('supertest');
const { ProfileMediaController, ProfileMediaGate, ProfileMediaSession } = require('./profile-media.controller');
const { PostMediaService } = require('./post-media.service');
const { ProfileMediaService } = require('./profile-media.service');
const { ProfileMediaAuth } = require('./profile-media-auth.service');
const { ProfileMediaUploads } = require('./profile-media-uploads.service');
const { PROFILE_MEDIA_CONFIG } = require('./profile-media.config');

test('reload recovery reads only scoped completion status without a wallet session', async () => {
  const address = AccountMemory.generate().address;
  const otherAddress = AccountMemory.generate().address;
  const id = '11111111-1111-4111-8111-111111111111';
  const config = { enabled: true, scope: 'recovery-test' };
  let state = 'submitted', rateChecks = 0;
  const db = { query: async (sql, params) => {
    assert.equal(sql, 'SELECT id,role,state FROM profile_media_writes WHERE scope=$1 AND id=$2 AND address=$3');
    assert.equal(params[0], config.scope);
    return params[1] === id && params[2] === address
      ? [{ id, role: 'cover', state, cid: 'unpublished', signed_tx: 'private', message: 'private' }] : [];
  } };
  const auth = { rate: async () => { rateChecks++; }, authenticate: async () => { throw new UnauthorizedException(); } };
  const service = new ProfileMediaService(db, auth, {}, config);
  // Exercise the real controller and guards; startup chain provisioning is unrelated.
  service.onApplicationBootstrap = async () => {};
  const module = await Test.createTestingModule({ controllers: [ProfileMediaController], providers: [
    ProfileMediaGate, ProfileMediaSession,
    { provide: PostMediaService, useValue: {} },
    { provide: ProfileMediaService, useValue: service },
    { provide: ProfileMediaAuth, useValue: auth },
    { provide: ProfileMediaUploads, useValue: {} },
    { provide: PROFILE_MEDIA_CONFIG, useValue: config },
  ] }).compile();
  const app = module.createNestApplication();
  await app.init();
  try {
    const api = request(app.getHttpServer());
    const path = `/profile-media/writes/${id}`;
    for (state of ['prepared', 'signed', 'submitted', 'confirmed', 'failed']) {
      const response = await api.get(`${path}/status`).query({ address }).expect(200);
      assert.deepEqual(response.body, { id, role: 'cover', status: state });
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    await api.get(`${path}/status`).query({ address: otherAddress }).expect(404);
    await api.get(`${path}/status`).query({ address: 'invalid' }).expect(400);
    await api.get(`${path}/status`).expect(400);
    await api.get('/profile-media/writes/invalid/status').query({ address }).expect(400);
    await api.get(path).expect(401);
    await api.post('/profile-media/submit').send({ id, signature: 'invalid' }).expect(401);
    await api.post('/profile-media/uploads').send({}).expect(401);
    await api.post('/profile-media/attachments').send({cids:[]}).expect(401);
    assert.equal(rateChecks, 13);
  } finally { await app.close(); }
});

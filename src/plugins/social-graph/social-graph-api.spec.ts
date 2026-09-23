import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { SocialGraphController } from './social-graph.controller';
import { SocialGraphService } from './social-graph.service';
import { SocialGraphQueryService } from './social-graph-query.service';
import { ProfileReadService } from '@/profile/services/profile-read.service';
import { SocialGraphReader } from './social-graph-reader';

describe('Social graph API', () => {
  it('validates the real HTTP precheck route before touching the node', async () => {
    const policy = jest.fn().mockResolvedValue({ block_hash: 'mh_abc' });
    const simulate = jest
      .fn()
      .mockResolvedValue({ advisory: true, simulation: 'passed' });
    const module = await Test.createTestingModule({
      controllers: [SocialGraphController],
      providers: [
        {
          provide: SocialGraphService,
          useValue: { getReader: () => ({ precheck: simulate, policy }) },
        },
        { provide: SocialGraphQueryService, useValue: {} },
        { provide: ProfileReadService, useValue: {} },
      ],
    }).compile();
    const app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    try {
      await request(app.getHttpServer())
        .get('/api/social-graph/policy')
        .expect(200, { block_hash: 'mh_abc' });
      expect(policy).toHaveBeenCalledWith('top');
      for (const body of [
        { action: 'freeze', from: 'ak_a', to: 'ak_b' },
        { action: 'follow', from: 'invalid', to: 'ak_b' },
        { action: 'follow', from: 'ak_a', to: 'ak_b', contract: 'ct_injected' },
      ])
        await request(app.getHttpServer())
          .post('/api/social-graph/precheck')
          .send(body)
          .expect(400);
      expect(simulate).not.toHaveBeenCalled();
      await request(app.getHttpServer())
        .post('/api/social-graph/precheck')
        .send({ action: 'follow', from: 'ak_a', to: 'ak_b' })
        .expect(204);
      expect(simulate).toHaveBeenCalledWith('follow', 'ak_a', 'ak_b');
      for (const [reason, status] of [
        ['FROZEN', 409],
        ['LOW_BALANCE', 409],
        ['BLOCKED', 403],
        ['FOLLOW_COOLDOWN', 429],
      ] as const) {
        simulate.mockResolvedValue({ reason, suggested_http_status: status });
        await request(app.getHttpServer())
          .post('/api/social-graph/precheck')
          .send({ action: 'follow', from: 'ak_a', to: 'ak_b' })
          .expect(status, {
            statusCode: status,
            error: reason,
            message: reason,
          });
      }
      await request(app.getHttpServer())
        .post('/api/social-graph/v2/precheck')
        .send({ action: 'follow', from: 'ak_a', to: 'ak_b' })
        .expect(404);
    } finally {
      await app.close();
    }
  });
  it('publishes explicit response schemas and validates profile ordering/fallback shape', async () => {
    const profiles = {
      getProfilesByAddresses: jest
        .fn()
        .mockResolvedValue([
          { address: 'ak_b', public_name: 'B', profile: { fullname: 'B' } },
        ]),
    };
    const scope = { network: 'ae_dev', contract: 'ct_test', generation: '1' };
    const queries = {
      ready: async () => scope,
      counts: jest.fn().mockResolvedValue({
        ...scope,
        address: 'ak_c',
        followers: '1',
        completed_height: '99',
      }),
      connections: async () => ({
        ...scope,
        account: 'ak_c',
        addresses: ['ak_a', 'ak_b'],
        next_cursor: null,
      }),
    };
    const graph = {
      getReader: () => ({ identity: scope, verifyIdentity: async () => {} }),
    };
    const m = await Test.createTestingModule({
      controllers: [SocialGraphController],
      providers: [
        { provide: SocialGraphService, useValue: graph },
        { provide: SocialGraphQueryService, useValue: queries },
        { provide: ProfileReadService, useValue: profiles },
      ],
    }).compile();
    const app = m.createNestApplication();
    try {
      const doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('test').build(),
      );
      for (const [path, method] of [
        ['status', 'get'],
        ['counts', 'get'],
        ['connections', 'get'],
        ['page', 'get'],
        ['policy', 'get'],
        ['relationship', 'get'],
      ])
        expect(
          doc.paths[`/social-graph/${path}`][method].responses['200'].content[
            'application/json'
          ].schema.$ref,
        ).toMatch(/Graph/);
      expect(
        doc.paths['/social-graph/precheck'].post.responses['204'],
      ).toBeDefined();
      for (const route of ['followers', 'following']) {
        const params = doc.paths[`/social-graph/${route}`].get
          .parameters as any[];
        expect(params.find((p) => p.name === 'address').required).toBe(true);
        for (const name of ['search', 'cursor', 'limit'])
          expect(params.find((p) => p.name === name).required).toBe(false);
      }
      expect(Object.keys(doc.paths).some((path) => path.includes('/v2'))).toBe(
        false,
      );
      const page = await m
        .get(SocialGraphController)
        .connections('ak_c', 'followers', 20);
      expect(page.items.map((i) => i.address)).toEqual(['ak_a', 'ak_b']);
      expect(page.items[0]).toMatchObject({
        public_name: 'ak_a',
        profile: { site: null },
      });
      expect(profiles.getProfilesByAddresses).toHaveBeenCalledTimes(1);
      await app.init();
      const response = await request(app.getHttpServer())
        .get('/social-graph/followers?address=ak_c&limit=20')
        .expect(200);
      expect(Object.keys(response.body).sort()).toEqual([
        'items',
        'next_cursor',
      ]);
      expect(response.body.items.map((i) => i.address)).toEqual([
        'ak_a',
        'ak_b',
      ]);
      await request(app.getHttpServer())
        .get('/social-graph/following?address=ak_c&limit=20')
        .expect(200);
    } finally {
      await app.close();
    }
  });
  it('simulates without caller funding, pins nonce/policy/state and returns actionable aborts', async () => {
    const top = 'mh_abc';
    const dry = jest.fn().mockResolvedValue({
      results: [
        {
          result: 'ok',
          callObj: {
            returnType: 'revert',
            returnValue: 'cb_reason',
            gasUsed: 25,
          },
        },
      ],
    });
    const account = jest.fn().mockResolvedValue({ kind: 'basic', nonce: 12 });
    const node: any = {
      getTopHeader: jest.fn().mockResolvedValue({ hash: top, height: 100 }),
      getAccountByPubkeyAndHash: account,
      protectedDryRunTxs: dry,
    };
    const reader = new SocialGraphReader(node, {
      network: 'ae_dev',
      contract: 'ct_abc',
    });
    const policy = jest
      .fn()
      .mockResolvedValue({ decodedResult: [{}, 3n, null] });
    (reader as any).contract = Promise.resolve({
      _name: 'SocialContract',
      _calldata: {
        encode: () => 'cb_encoded',
        decodeFateString: () => 'LOW_BALANCE',
      },
      get_policy: policy,
    });
    expect(await reader.precheck('follow', 'ak_a', 'ak_b')).toMatchObject({
      advisory: true,
      simulation: 'rejected',
      reason: 'LOW_BALANCE',
      config_version: '3',
      suggested_http_status: 409,
    });
    expect(dry.mock.calls[0][0]).toEqual({
      top,
      accounts: [],
      txs: [
        {
          callReq: {
            contract: 'ct_abc',
            caller: 'ak_a',
            calldata: 'cb_encoded',
            nonce: 13,
            gas: 1500000,
            abiVersion: 3,
            context: { stateful: false },
          },
        },
      ],
    });
    expect(account).toHaveBeenCalledWith('ak_a', top);
    expect(policy).toHaveBeenCalledWith({ top, callStatic: true });
    expect(node.getTopHeader).toHaveBeenCalledTimes(1);
    await expect(reader.precheck('freeze', 'ak_a', 'ak_b')).rejects.toThrow(
      'Invalid',
    );
    dry.mockResolvedValue({
      results: [{ result: 'error', reason: 'timeout' }],
    });
    await expect(reader.precheck('follow', 'ak_a', 'ak_b')).rejects.toThrow(
      'unavailable',
    );
    dry.mockRejectedValue(new Error('Upstream private diagnostic'));
    await expect(
      reader.precheck('follow', 'ak_a', 'ak_b'),
    ).rejects.toMatchObject({
      status: 503,
      message:
        'Graph simulation unavailable; retry with the wallet before signing',
    });
  });
});

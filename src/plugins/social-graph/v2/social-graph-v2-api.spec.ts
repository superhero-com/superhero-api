import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { SocialGraphV2Controller } from './social-graph-v2.controller';
import { SocialGraphV2Service } from './social-graph-v2.service';
import { SocialGraphV2QueryService } from './social-graph-v2-query.service';
import { ProfileReadService } from '@/profile/services/profile-read.service';
import { SocialGraphV2Reader } from './social-graph-v2-reader';

describe('V2 client API', () => {
  it('validates the real HTTP precheck route before touching the node', async () => {
    const simulate = jest
      .fn()
      .mockResolvedValue({ advisory: true, simulation: 'passed' });
    const module = await Test.createTestingModule({
      controllers: [SocialGraphV2Controller],
      providers: [
        {
          provide: SocialGraphV2Service,
          useValue: { getReader: () => ({ precheck: simulate }) },
        },
        { provide: SocialGraphV2QueryService, useValue: {} },
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
      for (const body of [
        { action: 'freeze', from: 'ak_a', to: 'ak_b' },
        { action: 'follow', from: 'invalid', to: 'ak_b' },
        { action: 'follow', from: 'ak_a', to: 'ak_b', contract: 'ct_injected' },
      ])
        await request(app.getHttpServer())
          .post('/api/social-graph/v2/precheck')
          .send(body)
          .expect(400);
      expect(simulate).not.toHaveBeenCalled();
      await request(app.getHttpServer())
        .post('/api/social-graph/v2/precheck')
        .send({ action: 'follow', from: 'ak_a', to: 'ak_b' })
        .expect(200, { advisory: true, simulation: 'passed' });
      expect(simulate).toHaveBeenCalledWith('follow', 'ak_a', 'ak_b');
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
      controllers: [SocialGraphV2Controller],
      providers: [
        { provide: SocialGraphV2Service, useValue: graph },
        { provide: SocialGraphV2QueryService, useValue: queries },
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
        ['precheck', 'post'],
      ])
        expect(
          doc.paths[`/social-graph/v2/${path}`][method].responses['200']
            .content['application/json'].schema.$ref,
        ).toMatch(/GraphV2/);
      const page = await m
        .get(SocialGraphV2Controller)
        .connections('ak_c', 'followers', 20);
      expect(page.items.map((i) => i.address)).toEqual(['ak_a', 'ak_b']);
      expect(page.items[0]).toMatchObject({
        public_name: 'ak_a',
        profile: { site: null },
      });
      expect(profiles.getProfilesByAddresses).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it('simulates without caller funding, pins nonce/policy/state and returns actionable aborts', async () => {
    const top = 'kh_abc';
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
      getCurrentKeyBlock: async () => ({ hash: top, height: 100 }),
      getAccountByPubkeyAndHash: account,
      protectedDryRunTxs: dry,
    };
    const reader = new SocialGraphV2Reader(node, {
      network: 'ae_dev',
      contract: 'ct_abc',
    });
    (reader as any).contract = Promise.resolve({
      _name: 'SocialContract',
      _calldata: {
        encode: () => 'cb_encoded',
        decodeFateString: () => 'LOW_BALANCE',
      },
      get_policy: async () => ({ decodedResult: [{}, 3n, null] }),
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

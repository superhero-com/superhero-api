import { CacheModule } from '@nestjs/cache-manager';
import {
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { GovernanceVoteService } from '../services/governance-vote.service';
import { GovernancePowerService } from '../services/governance-power.service';
import { GovernanceVotesController } from './governance-votes.controller';
import { GovernancePowerController } from './governance-power.controller';

const ACCOUNT = 'ak_2nSfuy3cLrAiRyp8RnKx1pJTHcNytrft1xC4HKXuzDRx77j5Kd';
const POLL = 'ct_DpHEeG2CWryVENFXmpzeCWWic3gaqTvryHYZF9oj4GoR7ofMr';

describe('Governance API', () => {
  let app: INestApplication;
  const votes = { findAll: jest.fn(), findOne: jest.fn() };
  const power = { getPollPower: jest.fn(), getDelegatedPower: jest.fn() };
  const get = (path: string) => request(app.getHttpServer()).get(path);

  beforeEach(async () => {
    jest.resetAllMocks();
    votes.findAll.mockResolvedValue({ items: [], meta: {} });
    votes.findOne.mockResolvedValue({ poll: {}, votes: [] });
    power.getPollPower.mockResolvedValue({ poll_address: POLL });
    power.getDelegatedPower.mockResolvedValue({ account: ACCOUNT });

    const module = await Test.createTestingModule({
      imports: [CacheModule.register()],
      controllers: [GovernanceVotesController, GovernancePowerController],
      providers: [
        { provide: GovernanceVoteService, useValue: votes },
        { provide: GovernancePowerService, useValue: power },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    // Same global pipe as main.ts: it turns a repeated query param into 'a,b'.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('passes the poll list filters to the service', async () => {
    await get('/governance/votes').expect(200);
    expect(votes.findAll).toHaveBeenLastCalledWith(
      { page: 1, limit: 100 },
      { status: undefined, author: undefined },
    );

    await get(`/governance/votes?status=closed&author=${ACCOUNT}`).expect(200);
    expect(votes.findAll).toHaveBeenLastCalledWith(
      { page: 1, limit: 100 },
      { status: 'closed', author: ACCOUNT },
    );
  });

  it('rejects invalid poll list filters with 400', async () => {
    for (const query of [
      'status=bogus',
      'status=OPEN',
      'status=open&status=closed',
      'author=ak_invalid',
    ]) {
      await get(`/governance/votes?${query}`).expect(400);
    }
    expect(votes.findAll).not.toHaveBeenCalled();
  });

  it('serves poll detail and poll power under the same poll path', async () => {
    await get(`/governance/votes/${POLL}`).expect(200);
    expect(votes.findOne).toHaveBeenCalledWith(POLL);

    await get(`/governance/votes/${POLL}/power`).expect(200, {
      poll_address: POLL,
    });
    expect(power.getPollPower).toHaveBeenCalledWith(POLL);

    await get(`/governance/polls/${POLL}/power`).expect(404);
  });

  it('validates addresses on the power routes', async () => {
    await get('/governance/votes/not-a-poll/power').expect(400);
    await get('/governance/power/not-an-account').expect(400);
    await get(`/governance/power/${ACCOUNT}?poll=not-a-poll`).expect(400);
    expect(power.getPollPower).not.toHaveBeenCalled();
    expect(power.getDelegatedPower).not.toHaveBeenCalled();

    await get(`/governance/power/${ACCOUNT}?poll=${POLL}`).expect(200);
    expect(power.getDelegatedPower).toHaveBeenCalledWith(ACCOUNT, POLL);
  });

  it('caches power results but never failures', async () => {
    power.getPollPower.mockRejectedValueOnce(new Error('node unavailable'));
    await get(`/governance/votes/${POLL}/power`).expect(500);
    await get(`/governance/votes/${POLL}/power`).expect(200);
    await get(`/governance/votes/${POLL}/power`).expect(200);
    expect(power.getPollPower).toHaveBeenCalledTimes(2);

    power.getDelegatedPower.mockRejectedValueOnce(new NotFoundException());
    await get(`/governance/power/${ACCOUNT}?poll=${POLL}`).expect(404);
    await get(`/governance/power/${ACCOUNT}?poll=${POLL}`).expect(200);
    await get(`/governance/power/${ACCOUNT}?poll=${POLL}`).expect(200);
    expect(power.getDelegatedPower).toHaveBeenCalledTimes(2);
  });

  it('documents the status values and the poll power path', () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('test').build(),
    );
    const status = (
      doc.paths['/governance/votes'].get.parameters as any[]
    ).find((p) => p.name === 'status');
    expect(status.schema.enum).toEqual(['open', 'closed', 'all']);
    expect(
      doc.paths['/governance/votes/{pollAddress}/power'].get.operationId,
    ).toBe('getGovernancePollPower');
  });
});

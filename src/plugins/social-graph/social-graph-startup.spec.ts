import { Controller, Get } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ProfileReadService } from '@/profile/services/profile-read.service';
import { SocialGraphController } from './social-graph.controller';
import { SocialGraphGateway } from './social-graph.gateway';
import { SocialGraphPlugin } from './social-graph.plugin';
import { SocialGraphQueryService } from './social-graph-query.service';
import { SocialGraphService } from './social-graph.service';
import { SocialGraphWorkerService } from './social-graph-worker.service';

@Controller('startup-probe')
class StartupProbeController {
  @Get()
  ready() {
    return { ready: true };
  }
}

describe('Optional social graph startup', () => {
  const saved = {
    SOCIAL_GRAPH_CONTRACT_ADDRESS: process.env.SOCIAL_GRAPH_CONTRACT_ADDRESS,
    SOCIAL_GRAPH_NETWORK_ID: process.env.SOCIAL_GRAPH_NETWORK_ID,
    SOCIAL_GRAPH_WORKER_ENABLED: process.env.SOCIAL_GRAPH_WORKER_ENABLED,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each([
    ['both missing', '', ''],
    ['network missing', 'ct_abc', ''],
    ['network blank', 'ct_abc', '  '],
    ['address missing', '', 'ae_mainnet'],
    ['address blank', '  ', 'ae_mainnet'],
  ])(
    'boots with %s and keeps graph routes unavailable',
    async (_, address, network) => {
      process.env.SOCIAL_GRAPH_CONTRACT_ADDRESS = address;
      process.env.SOCIAL_GRAPH_NETWORK_ID = network;
      process.env.SOCIAL_GRAPH_WORKER_ENABLED = 'true';
      const ae = { sdk: { getContext: jest.fn() } };
      const db = { createQueryRunner: jest.fn(), query: jest.fn() };
      const queries = { ready: jest.fn(), counts: jest.fn() };
      const graph = new SocialGraphService(ae as any, queries as any);
      const gateway = new SocialGraphGateway(db as any, graph);
      const websocket = {
        subscribeForMicroBlocksUpdates: jest.fn(),
        subscribeForKeyBlocksUpdates: jest.fn(),
        subscribeForConnection: jest.fn(),
      };
      const worker = new SocialGraphWorkerService(
        db as any,
        ae as any,
        graph,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        websocket as any,
        gateway,
      );
      const plugin = new SocialGraphPlugin(
        {} as any,
        {} as any,
        {} as any,
        graph,
        worker,
        db as any,
        gateway,
      );
      const module = await Test.createTestingModule({
        controllers: [StartupProbeController, SocialGraphController],
        providers: [
          { provide: SocialGraphService, useValue: graph },
          { provide: SocialGraphQueryService, useValue: queries },
          { provide: ProfileReadService, useValue: {} },
          { provide: SocialGraphWorkerService, useValue: worker },
          { provide: SocialGraphGateway, useValue: gateway },
        ],
      }).compile();
      const app = module.createNestApplication({ logger: false });
      try {
        await app.init();
        await request(app.getHttpServer())
          .get('/startup-probe')
          .expect(200, { ready: true });
        for (const path of [
          'config',
          'policy',
          'status',
          'counts?account=ak_a',
        ]) {
          const response = await request(app.getHttpServer())
            .get(`/social-graph/${path}`)
            .expect(503);
          expect(response.body.message).toBe(
            'Social graph contract and network are not configured',
          );
        }
        expect(graph.isConfigured()).toBe(false);
        expect(plugin.filters()).toEqual([]);
        await plugin.onReorg(['th_removed']);
        worker.requestSync();
        await expect(worker.tick()).resolves.toBe('idle');
        for (const subscribe of Object.values(websocket))
          expect(subscribe).not.toHaveBeenCalled();
        expect(db.createQueryRunner).not.toHaveBeenCalled();
        expect(db.query).not.toHaveBeenCalled();
        expect(ae.sdk.getContext).not.toHaveBeenCalled();
        expect(queries.ready).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
});

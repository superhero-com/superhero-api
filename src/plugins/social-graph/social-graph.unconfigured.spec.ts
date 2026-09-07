// Proves the feature boots fully disabled when SOCIAL_GRAPH_CONTRACT_ADDRESS is
// unset: the contract service inits without ever reaching the chain, the config
// read reports unconfigured, and the indexer plugin registers no filters. The
// sibling wiring spec only resolves symbols and would pass against a service
// that throws on boot; this exercises the unset path end to end. Modules are
// re-required with the env var deleted so the module-level address constant is
// recomputed as empty.
describe('social-graph (unconfigured — SOCIAL_GRAPH_CONTRACT_ADDRESS unset)', () => {
  const KEY = 'SOCIAL_GRAPH_CONTRACT_ADDRESS';
  const original = process.env[KEY];

  beforeAll(() => {
    delete process.env[KEY];
  });

  afterAll(() => {
    if (original === undefined) {
      delete process.env[KEY];
    } else {
      process.env[KEY] = original;
    }
  });

  function loadFresh() {
    let mod: {
      SocialGraphContractService: any;
      SocialGraphPlugin: any;
    };
    jest.isolateModules(() => {
      mod = {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        SocialGraphContractService: require('./social-graph-contract.service')
          .SocialGraphContractService,
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        SocialGraphPlugin: require('./social-graph.plugin').SocialGraphPlugin,
      };
    });
    return mod!;
  }

  it('inits the contract service without reaching the chain and reports unconfigured', async () => {
    const { SocialGraphContractService } = loadFresh();
    // Any property access throws, so a passing test proves the unset boot path
    // never touches the SDK.
    const sdkThatMustNotBeUsed = new Proxy(
      {},
      {
        get() {
          throw new Error(
            'AeSdkService must not be used when the contract is unconfigured',
          );
        },
      },
    );
    const service = new SocialGraphContractService(sdkThatMustNotBeUsed);

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(service.isConfigured()).toBe(false);

    // getConfig() signals unconfigured with a 503, never a plausible fallback.
    // The status/message are asserted rather than the class, which jest's module
    // isolation loads as a distinct copy of ServiceUnavailableException.
    let caught: any;
    try {
      service.getConfig();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught.getStatus()).toBe(503);
    expect(caught.message).toContain('not configured');
  });

  it('registers no indexer filters', () => {
    const { SocialGraphPlugin } = loadFresh();
    const plugin = new SocialGraphPlugin(
      undefined as any,
      undefined as any,
      undefined as any,
    );

    expect(plugin.filters()).toEqual([]);
  });

  // The guard fires on the real Nest request path, before the handlers and the
  // in-service getConfig() throw. @nestjs/testing, supertest and the controller
  // are all required inside the one isolateModules block so they share a single
  // fresh module graph — otherwise the 503's ServiceUnavailableException fails
  // the framework's instanceof HttpException check and degrades to a 500.
  describe('every /social-graph route answers 503 uniformly', () => {
    let app: any;
    let request: any;

    beforeAll(async () => {
      let mods: any;
      jest.isolateModules(() => {
        mods = {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          Test: require('@nestjs/testing').Test,
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          request: require('supertest'),
          SocialGraphController:
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require('./social-graph.controller').SocialGraphController,
          SocialGraphConfiguredGuard:
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require('./social-graph-configured.guard')
              .SocialGraphConfiguredGuard,
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          SocialGraphService: require('./social-graph.service')
            .SocialGraphService,
          SocialGraphContractService:
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require('./social-graph-contract.service')
              .SocialGraphContractService,
        };
      });
      request = mods.request;

      // The service methods are stubbed to throw: reaching them at all would be a
      // guard bypass, so a green test proves the 503 comes from the guard.
      const mustNotRun = () => {
        throw new Error('handler reached while unconfigured');
      };
      const moduleRef = await mods.Test.createTestingModule({
        controllers: [mods.SocialGraphController],
        providers: [
          mods.SocialGraphConfiguredGuard,
          {
            provide: mods.SocialGraphService,
            useValue: { getRelationship: mustNotRun, precheck: mustNotRun },
          },
          {
            provide: mods.SocialGraphContractService,
            useValue: { getConfig: mustNotRun },
          },
        ],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
    });

    afterAll(async () => {
      await app?.close();
    });

    it('GET /social-graph/relationship → 503', () =>
      request(app.getHttpServer())
        .get('/social-graph/relationship')
        .query({ from: 'ak_from', to: 'ak_to' })
        .expect(503));

    it('GET /social-graph/config → 503', () =>
      request(app.getHttpServer()).get('/social-graph/config').expect(503));

    // All four actions, including unfollow/unblock which the service would have
    // answered from the empty index — the guard now stops them before the service.
    it.each(['follow', 'unfollow', 'block', 'unblock'])(
      'POST /social-graph/precheck (%s) → 503',
      (action) =>
        request(app.getHttpServer())
          .post('/social-graph/precheck')
          .send({ action, from: 'ak_from', to: 'ak_to' })
          .expect(503),
    );
  });

  it('getProfile omits both count keys and never reads the counts table', async () => {
    let ProfileReadService: any;
    jest.isolateModules(() => {
      ProfileReadService =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('@/profile/services/profile-read.service').ProfileReadService;
    });
    const findOne = jest.fn();
    const service = new ProfileReadService(
      { findOne: jest.fn().mockResolvedValue(null) },
      { findOne: jest.fn().mockResolvedValue(null) },
      { findOne },
    );

    const result = await service.getProfile('ak_test');

    expect(result.profile).not.toHaveProperty('followers_count');
    expect(result.profile).not.toHaveProperty('following_count');
    expect(findOne).not.toHaveBeenCalled();
  });
});

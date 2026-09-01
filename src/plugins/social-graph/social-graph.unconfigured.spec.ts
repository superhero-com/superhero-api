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
});

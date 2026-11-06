import { SocialGraphService, safeGraphNumber } from './social-graph.service';
import { SocialGraphReader } from './social-graph-reader';
import { SocialGraphWorkerService } from './social-graph-worker.service';

describe('Social graph selection', () => {
  const saved = {
    address: process.env.SOCIAL_GRAPH_CONTRACT_ADDRESS,
    network: process.env.SOCIAL_GRAPH_NETWORK_ID,
  };
  afterEach(() => {
    for (const [key, value] of [
      ['SOCIAL_GRAPH_CONTRACT_ADDRESS', saved.address],
      ['SOCIAL_GRAPH_NETWORK_ID', saved.network],
    ]) {
      if (value == null) delete process.env[key!];
      else process.env[key!] = value;
    }
    jest.restoreAllMocks();
  });
  const create = () =>
    new SocialGraphService(
      { sdk: { getContext: () => ({ onNode: {} }) } } as any,
      {} as any,
    );
  it('stays disabled without a contract or with incomplete network configuration', async () => {
    delete process.env.SOCIAL_GRAPH_CONTRACT_ADDRESS;
    const graph = create();
    expect(graph.isConfigured()).toBe(false);
    await graph.onModuleInit();
    expect(() => graph.getReader()).toThrow('not configured');
    process.env.SOCIAL_GRAPH_CONTRACT_ADDRESS = 'ct_abc';
    delete process.env.SOCIAL_GRAPH_NETWORK_ID;
    expect(graph.isConfigured()).toBe(false);
    await expect(graph.onModuleInit()).resolves.toBeUndefined();
    expect(() => graph.getReader()).toThrow('not configured');
  });
  it('verifies identity on startup through the existing configuration names', async () => {
    process.env.SOCIAL_GRAPH_CONTRACT_ADDRESS = 'ct_abc';
    process.env.SOCIAL_GRAPH_NETWORK_ID = 'ae_dev';
    const verify = jest
      .spyOn(SocialGraphReader.prototype, 'verifyIdentity')
      .mockResolvedValue();
    const graph = create();
    await graph.onModuleInit();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(graph.getReader().identity).toEqual({
      network: 'ae_dev',
      contract: 'ct_abc',
    });
    verify.mockRejectedValue(new Error('Network mismatch'));
    await expect(create().onModuleInit()).rejects.toThrow('Network mismatch');
  });
  it('reads changed policy each time without pinning mutable caps at startup', async () => {
    const graph = create();
    const policy = jest
      .fn()
      .mockResolvedValueOnce({
        contract: 'ct_abc',
        config: {
          max_following: '100',
          max_blocked: '50',
          follow_cooldown: '0',
        },
      })
      .mockResolvedValueOnce({
        contract: 'ct_abc',
        config: {
          max_following: '200',
          max_blocked: '75',
          follow_cooldown: '10',
        },
      });
    jest.spyOn(graph, 'getReader').mockReturnValue({ policy } as any);
    expect(await graph.getConfig()).toEqual({
      contract_address: 'ct_abc',
      max_following: 100,
      max_blocked: 50,
      follow_cooldown: 0,
    });
    expect((await graph.getConfig()).max_following).toBe(200);
  });
  it('never rounds the numeric values required by existing profile clients', () => {
    expect(safeGraphNumber('1000000')).toBe(1000000);
    expect(() => safeGraphNumber('9007199254740993')).toThrow('client range');
  });
  it('serves profile counts only from the current ready namespace', async () => {
    const queries = {
      ready: jest.fn().mockResolvedValue({
        network: 'ae_dev',
        contract: 'ct_selected',
        generation: '2',
      }),
      counts: jest
        .fn()
        .mockResolvedValue({ followers: '1000000', following: '4' }),
    };
    const graph = new SocialGraphService({} as any, queries as any);
    jest.spyOn(graph, 'getReader').mockReturnValue({
      identity: { network: 'ae_dev', contract: 'ct_selected' },
      verifyIdentity: jest.fn(),
    } as any);
    expect(await graph.getFollowCounts('ak_abc')).toEqual({
      followers_count: 1000000,
      following_count: 4,
    });
    expect(queries.counts).toHaveBeenCalledWith(
      { network: 'ae_dev', contract: 'ct_selected', generation: '2' },
      'ak_abc',
    );
    queries.ready.mockRejectedValue(new Error('Graph not ready'));
    await expect(graph.getFollowCounts('ak_abc')).rejects.toThrow('not ready');
  });
  it('does not acquire a database connection for an unconfigured worker', async () => {
    const db = { createQueryRunner: jest.fn() };
    const graph = { isConfigured: () => false };
    const worker = new SocialGraphWorkerService(
      db as any,
      {} as any,
      graph as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    await worker.tick();
    expect(db.createQueryRunner).not.toHaveBeenCalled();
  });
});

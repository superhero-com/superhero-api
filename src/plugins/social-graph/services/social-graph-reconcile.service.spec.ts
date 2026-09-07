import { Logger } from '@nestjs/common';
import { SocialGraphReconcileService } from './social-graph-reconcile.service';

const ADDR = 'ak_alice';

type Edge = { id: number; from_address: string; to_address: string };
/** [followers, following] */
type Counts = Record<string, [number, number]>;

/**
 * Query-builder stub honouring the `edge.id > :lastCheckedId` bound the service
 * pages on, so consecutive passes see only edges added since the previous one.
 */
const edgeRepo = (
  edges: Edge[],
  query = jest.fn().mockResolvedValue(undefined),
) => ({
  manager: { query },
  createQueryBuilder: () => {
    let after = 0;
    const qb: any = {
      select: () => qb,
      addSelect: () => qb,
      orderBy: () => qb,
      where: (_sql: string, params: { lastCheckedId: number }) => {
        after = params.lastCheckedId;
        return qb;
      },
      getRawOne: async () => ({ max: 0 }),
      getRawMany: async () => edges.filter((edge) => edge.id > after),
    };
    return qb;
  },
});

const countsOf = (counts: Counts) => ({
  getFollowersCount: async (address: string) => counts[address][0],
  getFollowingCount: async (address: string) => counts[address][1],
});

const storedCountsOf = (counts: Counts) => ({
  findOne: async ({ where: { address } }: { where: { address: string } }) => {
    const count = counts[address];
    if (!count) {
      return null;
    }
    return { followers_count: count[0], following_count: count[1] };
  },
});

const build = (edges: Edge[], indexed: Counts, chain: Counts) =>
  new SocialGraphReconcileService(
    edgeRepo(edges) as any,
    storedCountsOf(indexed) as any,
    { isConfigured: () => true, ...countsOf(chain) } as any,
    countsOf(indexed) as any,
  );

function makeService({
  stored,
  edgeFollowers,
  edgeFollowing,
}: {
  stored: { followers_count: number; following_count: number } | null;
  edgeFollowers: number;
  edgeFollowing: number;
}) {
  const query = jest.fn().mockResolvedValue(undefined);
  const countRepo: any = { findOne: jest.fn().mockResolvedValue(stored) };
  const socialGraphService: any = {
    getFollowersCount: jest.fn().mockResolvedValue(edgeFollowers),
    getFollowingCount: jest.fn().mockResolvedValue(edgeFollowing),
  };
  const contractService: any = {};

  const service = new SocialGraphReconcileService(
    edgeRepo([], query) as any,
    countRepo,
    contractService,
    socialGraphService,
  );
  return { service, query };
}

describe('SocialGraphReconcileService drift alarm', () => {
  let errors: string[];

  beforeEach(() => {
    errors = [];
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((message: any) => void errors.push(String(message)));
  });

  afterEach(() => jest.restoreAllMocks());

  it('repeats the alarm, with repair guidance, on every drifting pass', async () => {
    // Only ak_alice drifts; her neighbours are consistent.
    const edges: Edge[] = [
      { id: 1, from_address: 'ak_alice', to_address: 'ak_bob' },
    ];
    const service = build(
      edges,
      { ak_alice: [3, 5], ak_bob: [1, 1], ak_carol: [1, 1] },
      { ak_alice: [5, 5], ak_bob: [1, 1], ak_carol: [1, 1] },
    );
    await service.onModuleInit();

    await service.reconcile();
    edges.push({ id: 2, from_address: 'ak_alice', to_address: 'ak_carol' });
    await service.reconcile();

    const drift = errors.filter((e) => e.includes('social-graph index drift'));
    expect(drift).toHaveLength(2);
    // Repair guidance rides on the drift line itself, so it is never a
    // once-per-process message an operator can miss after the first pass.
    for (const line of drift) {
      expect(line).toContain('ak_alice');
      expect(line).toContain('followers indexed=3 chain=5');
      expect(line).toContain('no automatic repair exists');
    }
  });

  it('stays silent when the index matches the chain', async () => {
    const service = build(
      [{ id: 1, from_address: 'ak_alice', to_address: 'ak_bob' }],
      { ak_alice: [5, 5], ak_bob: [1, 1] },
      { ak_alice: [5, 5], ak_bob: [1, 1] },
    );
    await service.onModuleInit();

    await service.reconcile();

    expect(errors).toEqual([]);
  });
});

describe('SocialGraphReconcileService.repairCounterDrift', () => {
  it('recomputes the counter when it disagrees with the edge table', async () => {
    const { service, query } = makeService({
      stored: { followers_count: 5, following_count: 0 },
      edgeFollowers: 6,
      edgeFollowing: 0,
    });

    await (service as any).repairCounterDrift(ADDR);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([ADDR]);
  });

  it('does nothing when the counter already matches the edge table', async () => {
    const { service, query } = makeService({
      stored: { followers_count: 2, following_count: 3 },
      edgeFollowers: 2,
      edgeFollowing: 3,
    });

    await (service as any).repairCounterDrift(ADDR);

    expect(query).not.toHaveBeenCalled();
  });

  it('treats a missing row as zero and recomputes when edges exist', async () => {
    const { service, query } = makeService({
      stored: null,
      edgeFollowers: 1,
      edgeFollowing: 0,
    });

    await (service as any).repairCounterDrift(ADDR);

    expect(query).toHaveBeenCalledTimes(1);
  });
});

import { SocialGraphService } from './social-graph.service';
import { SocialGraphContractService } from './social-graph-contract.service';
import { SOCIAL_GRAPH_ABORT_STATUS } from './social-graph.errors';

const A = 'ak_alice';
const B = 'ak_bob';
const C = 'ak_carol';

function edgeKey(from: string, to: string, kind: string): string {
  return `${from}|${to}|${kind}`;
}

/**
 * A repository double whose `count` reads the `where` clause the service builds:
 * both from+to => existence; from only => following/blocked count; to only =>
 * followers count.
 */
function makeEdgeRepo(edges: Set<string>) {
  return {
    count: jest.fn(async ({ where }: any) => {
      const { from_address, to_address, kind } = where;
      const all = [...edges].map((e) => e.split('|'));
      if (from_address && to_address) {
        return edges.has(edgeKey(from_address, to_address, kind)) ? 1 : 0;
      }
      if (from_address) {
        return all.filter(([f, , k]) => f === from_address && k === kind)
          .length;
      }
      if (to_address) {
        return all.filter(([, t, k]) => t === to_address && k === kind).length;
      }
      return 0;
    }),
  };
}

function makeService(
  edges: Set<string>,
  config: Partial<{ max_following: number; max_blocked: number }> = {},
) {
  const edgeRepo = makeEdgeRepo(edges);
  const contractService = {
    getConfig: () => ({
      max_following: config.max_following ?? 10000,
      max_blocked: config.max_blocked ?? 10000,
      follow_cooldown: 0,
      contract_address: 'ct_test',
    }),
  } as unknown as SocialGraphContractService;
  return new SocialGraphService(edgeRepo as any, contractService);
}

describe('SocialGraphService', () => {
  describe('counts and relationship', () => {
    it('counts followers, following and blocked from the index', async () => {
      const edges = new Set<string>([
        edgeKey(A, B, 'follow'), // A follows B
        edgeKey(C, B, 'follow'), // C follows B
        edgeKey(B, A, 'follow'), // B follows A
        edgeKey(A, C, 'block'), // A blocks C
      ]);
      const service = makeService(edges);
      expect(await service.getFollowersCount(B)).toBe(2);
      expect(await service.getFollowingCount(A)).toBe(1);
      expect(await service.getBlockedCount(A)).toBe(1);
    });

    it('reports the pair-wise relationship in both directions', async () => {
      const edges = new Set<string>([
        edgeKey(A, B, 'follow'),
        edgeKey(B, A, 'block'),
      ]);
      const service = makeService(edges);
      expect(await service.getRelationship(A, B)).toEqual({
        a_follows_b: true,
        b_follows_a: false,
        a_blocked_b: false,
        b_blocked_a: true,
      });
    });
  });

  describe('precheck follow', () => {
    it('passes (null) for a clean follow', async () => {
      const service = makeService(new Set());
      expect(await service.precheck('follow', A, B)).toBeNull();
    });

    it('CANNOT_FOLLOW_SELF', async () => {
      const service = makeService(new Set());
      expect(await service.precheck('follow', A, A)).toBe('CANNOT_FOLLOW_SELF');
    });

    it('BLOCKED when the target has blocked the caller', async () => {
      const service = makeService(new Set([edgeKey(B, A, 'block')]));
      expect(await service.precheck('follow', A, B)).toBe('BLOCKED');
    });

    it('BLOCKED_BY_SELF when the caller has blocked the target', async () => {
      const service = makeService(new Set([edgeKey(A, B, 'block')]));
      expect(await service.precheck('follow', A, B)).toBe('BLOCKED_BY_SELF');
    });

    it('ALREADY_FOLLOWING', async () => {
      const service = makeService(new Set([edgeKey(A, B, 'follow')]));
      expect(await service.precheck('follow', A, B)).toBe('ALREADY_FOLLOWING');
    });

    it('MAX_FOLLOWING_REACHED at the cap', async () => {
      const service = makeService(new Set([edgeKey(A, C, 'follow')]), {
        max_following: 1,
      });
      expect(await service.precheck('follow', A, B)).toBe(
        'MAX_FOLLOWING_REACHED',
      );
    });
  });

  describe('precheck unfollow', () => {
    it('NOT_FOLLOWING when no edge exists', async () => {
      const service = makeService(new Set());
      expect(await service.precheck('unfollow', A, B)).toBe('NOT_FOLLOWING');
    });

    it('passes (null) when following', async () => {
      const service = makeService(new Set([edgeKey(A, B, 'follow')]));
      expect(await service.precheck('unfollow', A, B)).toBeNull();
    });
  });

  describe('precheck block', () => {
    it('CANNOT_BLOCK_SELF', async () => {
      const service = makeService(new Set());
      expect(await service.precheck('block', A, A)).toBe('CANNOT_BLOCK_SELF');
    });

    it('ALREADY_BLOCKED', async () => {
      const service = makeService(new Set([edgeKey(A, B, 'block')]));
      expect(await service.precheck('block', A, B)).toBe('ALREADY_BLOCKED');
    });

    it('MAX_BLOCKED_REACHED at the cap', async () => {
      const service = makeService(new Set([edgeKey(A, C, 'block')]), {
        max_blocked: 1,
      });
      expect(await service.precheck('block', A, B)).toBe('MAX_BLOCKED_REACHED');
    });

    it('passes (null) for a clean block', async () => {
      const service = makeService(new Set());
      expect(await service.precheck('block', A, B)).toBeNull();
    });
  });

  describe('precheck unblock', () => {
    it('NOT_BLOCKED when no edge exists', async () => {
      const service = makeService(new Set());
      expect(await service.precheck('unblock', A, B)).toBe('NOT_BLOCKED');
    });

    it('passes (null) when blocked', async () => {
      const service = makeService(new Set([edgeKey(A, B, 'block')]));
      expect(await service.precheck('unblock', A, B)).toBeNull();
    });
  });

  describe('abort → HTTP status map', () => {
    it('maps every abort code the contract can produce, none invented', () => {
      expect(SOCIAL_GRAPH_ABORT_STATUS).toEqual({
        ALREADY_FOLLOWING: 409,
        NOT_FOLLOWING: 409,
        ALREADY_BLOCKED: 409,
        NOT_BLOCKED: 409,
        CANNOT_FOLLOW_SELF: 409,
        CANNOT_BLOCK_SELF: 409,
        BLOCKED: 403,
        BLOCKED_BY_SELF: 409,
        MAX_FOLLOWING_REACHED: 409,
        MAX_BLOCKED_REACHED: 409,
        FOLLOW_COOLDOWN: 429,
      });
    });

    it('keeps FOLLOW_COOLDOWN mapped to 429 even though it is unreachable at cooldown=0', () => {
      expect(SOCIAL_GRAPH_ABORT_STATUS.FOLLOW_COOLDOWN).toBe(429);
    });
  });
});

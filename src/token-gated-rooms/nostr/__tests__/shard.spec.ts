import { ownsGroupId, resolveShardIndex, shardForGroupId } from '../shard';

describe('shardForGroupId', () => {
  const SAMPLE_GIDS = Array.from(
    { length: 500 },
    (_, i) => `ct_${(i * 2654435761) >>> 0}sale${i}`,
  );

  it('returns 0 for shardCount <= 1', () => {
    for (const gid of ['ct_a', 'ct_b', '']) {
      expect(shardForGroupId(gid, 1)).toBe(0);
      expect(shardForGroupId(gid, 0)).toBe(0);
      expect(shardForGroupId(gid, -3)).toBe(0);
    }
  });

  it('is deterministic — the same gid always maps to the same shard', () => {
    for (const gid of SAMPLE_GIDS.slice(0, 50)) {
      const a = shardForGroupId(gid, 8);
      const b = shardForGroupId(gid, 8);
      expect(a).toBe(b);
    }
  });

  it('always returns an index in [0, shardCount)', () => {
    for (const count of [2, 3, 8, 16]) {
      for (const gid of SAMPLE_GIDS) {
        const idx = shardForGroupId(gid, count);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(count);
        expect(Number.isInteger(idx)).toBe(true);
      }
    }
  });

  it('floors a fractional shardCount', () => {
    const idx = shardForGroupId('ct_xyz', 4.9);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(4);
  });

  it('is reasonably balanced across sample gids', () => {
    const COUNT = 8;
    const buckets = new Array<number>(COUNT).fill(0);
    for (const gid of SAMPLE_GIDS) {
      buckets[shardForGroupId(gid, COUNT)] += 1;
    }
    const ideal = SAMPLE_GIDS.length / COUNT;
    // Every bucket within 50% of the ideal share (loose — just rule out a
    // degenerate "everything lands on one shard" hash).
    for (const n of buckets) {
      expect(n).toBeGreaterThan(ideal * 0.5);
      expect(n).toBeLessThan(ideal * 1.5);
    }
  });

  it('different gids can map to different shards (not a constant)', () => {
    const distinct = new Set(SAMPLE_GIDS.map((g) => shardForGroupId(g, 8)));
    expect(distinct.size).toBeGreaterThan(1);
  });
});

describe('ownsGroupId', () => {
  it('agrees with shardForGroupId', () => {
    const gid = 'ct_owner_test';
    const idx = shardForGroupId(gid, 4);
    expect(ownsGroupId(gid, idx, 4)).toBe(true);
    expect(ownsGroupId(gid, (idx + 1) % 4, 4)).toBe(false);
  });

  it('single-shard owns everything', () => {
    for (const gid of ['ct_a', 'ct_b', 'ct_c']) {
      expect(ownsGroupId(gid, 0, 1)).toBe(true);
    }
  });
});

describe('resolveShardIndex', () => {
  it('defaults to 0 when unset/blank', () => {
    expect(resolveShardIndex({}, 4)).toBe(0);
    expect(resolveShardIndex({ TG_SUBSCRIBER_SHARD_INDEX: '' }, 4)).toBe(0);
    expect(resolveShardIndex({ TG_SUBSCRIBER_SHARD_INDEX: '   ' }, 4)).toBe(0);
  });

  it('parses a valid 0-based ordinal in range', () => {
    expect(resolveShardIndex({ TG_SUBSCRIBER_SHARD_INDEX: '0' }, 4)).toBe(0);
    expect(resolveShardIndex({ TG_SUBSCRIBER_SHARD_INDEX: '3' }, 4)).toBe(3);
  });

  it('falls back to 0 for out-of-range / non-integer / negative', () => {
    expect(resolveShardIndex({ TG_SUBSCRIBER_SHARD_INDEX: '4' }, 4)).toBe(0);
    expect(resolveShardIndex({ TG_SUBSCRIBER_SHARD_INDEX: '-1' }, 4)).toBe(0);
    expect(resolveShardIndex({ TG_SUBSCRIBER_SHARD_INDEX: '1.5' }, 4)).toBe(0);
    expect(resolveShardIndex({ TG_SUBSCRIBER_SHARD_INDEX: 'abc' }, 4)).toBe(0);
  });
});

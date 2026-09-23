import { Contract, Encoded } from '@aeternity/aepp-sdk';
import {
  SocialGraphV2Reader,
  decimal,
  decodeGraphCursor,
  encodeGraphCursor,
} from './social-graph-v2-reader';

const identity = {
  network: 'ae_dev',
  contract: 'ct_abc' as Encoded.ContractAddress,
};
const top = 'kh_abc' as Encoded.KeyBlockHash;
const cursor = {
  ...identity,
  version: 2 as const,
  account: 'ak_abc',
  direction: 'followers' as const,
  top,
  offset: '100',
};

describe('V2 graph read boundaries', () => {
  afterEach(() => jest.restoreAllMocks());
  it('keeps large integers exact and rejects rounded numeric input', () => {
    expect(decimal(2n ** 100n)).toBe('1267650600228229401496703205376');
    expect(() => decimal(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => decimal('-1')).toThrow();
  });
  it('binds cursor to network, contract, account, direction and snapshot', () => {
    const token = encodeGraphCursor(cursor);
    expect(decodeGraphCursor(token, cursor)).toEqual(cursor);
    for (const patch of [
      { network: 'ae_mainnet' },
      { contract: 'ct_other' },
      { account: 'ak_other' },
      { direction: 'blocked' },
    ]) {
      expect(() =>
        decodeGraphCursor(token, { ...cursor, ...patch } as any),
      ).toThrow();
    }
  });
  it('rejects unknown bytecode before constructing any contract reader', async () => {
    const initialize = jest.spyOn(Contract, 'initialize');
    const node = {
      getStatus: async () => ({ networkId: 'ae_dev' }),
      getContractCode: async () => ({ bytecode: 'unknown' }),
    };
    await expect(
      new SocialGraphV2Reader(node as any, identity).policy(),
    ).rejects.toThrow('bytecode');
    expect(initialize).not.toHaveBeenCalled();
  });
  it('does not stop on empty sparse pages and pins continuation to the same block', async () => {
    const page = jest.fn().mockResolvedValue({
      decodedResult: { items: [], next_cursor: 100n, end_cursor: 200n },
    });
    const reader = new SocialGraphV2Reader(
      { getCurrentKeyBlock: async () => ({ hash: top }) } as any,
      identity,
    );
    // The identity boundary is tested separately; inject only the read-only contract instance.
    (reader as any).contract = Promise.resolve({ get_followers_page: page });
    const result = await reader.page('followers', 'ak_abc', 100);
    expect(result.items).toEqual([]);
    expect(result.next_cursor).not.toBeNull();
    expect(page).toHaveBeenCalledWith('ak_abc', 0n, 100, {
      top,
      callStatic: true,
    });
    page.mockResolvedValue({
      decodedResult: { items: [], next_cursor: 200n, end_cursor: 200n },
    });
    expect(
      (await reader.page('followers', 'ak_abc', 100, result.next_cursor))
        .next_cursor,
    ).toBeNull();
    expect(page).toHaveBeenLastCalledWith('ak_abc', 100n, 100, {
      top,
      callStatic: true,
    });
  });
  it('rejects stalled pages instead of creating an endless continuation', async () => {
    const reader = new SocialGraphV2Reader(
      { getCurrentKeyBlock: async () => ({ hash: top }) } as any,
      identity,
    );
    (reader as any).contract = Promise.resolve({
      export_page: async () => ({
        decodedResult: { items: [], next_cursor: 0n, end_cursor: 5n },
      }),
    });
    await expect(reader.page('export', '', 100)).rejects.toThrow('progress');
  });
});

describe('V2 event namespace', () => {
  it('filters foreign logs, preserves block cleanup order and does not turn imports into follows', async () => {
    const reader = new SocialGraphV2Reader({} as any, identity);
    (reader as any).contract = Promise.resolve({
      $decodeEvents: ([log]) => [{ name: log.name, args: log.args }],
    });
    const decoded = await reader.decodeLogs([
      { address: 'ct_foreign', name: 'Followed', args: ['ak_a', 'ak_b'] },
      {
        address: identity.contract,
        name: 'Unfollowed',
        args: ['ak_a', 'ak_b'],
      },
      {
        address: identity.contract,
        name: 'Unfollowed',
        args: ['ak_b', 'ak_a'],
      },
      { address: identity.contract, name: 'Blocked', args: ['ak_a', 'ak_b'] },
      {
        address: identity.contract,
        name: 'LowBalanceRemoved',
        args: ['ak_a', 'ak_b'],
      },
      { address: identity.contract, name: 'ImportProgress', args: [100n, 90n] },
      { address: identity.contract, name: 'Followed', args: ['ak_c', 'ak_d'] },
    ]);
    expect(decoded.map((e) => e.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(decoded.flatMap((e) => e.changes)).toEqual([
      { from: 'ak_a', to: 'ak_b', kind: 'follow', present: false },
      { from: 'ak_b', to: 'ak_a', kind: 'follow', present: false },
      { from: 'ak_a', to: 'ak_b', kind: 'block', present: true },
      { from: 'ak_c', to: 'ak_d', kind: 'follow', present: true },
    ]);
    expect(
      decoded.filter((e) => e.followAccount).map((e) => e.followAccount),
    ).toEqual(['ak_c']);
  });
  it('does not swallow decoder failures on the reviewed contract', async () => {
    const reader = new SocialGraphV2Reader({} as any, identity);
    (reader as any).contract = Promise.resolve({
      $decodeEvents: () => {
        throw new Error('missing definition');
      },
    });
    await expect(
      reader.decodeLogs([{ address: identity.contract }]),
    ).rejects.toThrow('missing definition');
  });
});

describe('V2 relationship snapshot', () => {
  it('pins relationship and lifecycle to the same key block and marks the view advisory', async () => {
    const relation = jest
      .fn()
      .mockResolvedValue({
        decodedResult: {
          a_follows_b: true,
          b_follows_a: false,
          a_blocked_b: false,
          b_blocked_a: false,
        },
      });
    const lifecycle = jest
      .fn()
      .mockResolvedValue({ decodedResult: [null, 0n, false, true] });
    const reader = new SocialGraphV2Reader(
      { getCurrentKeyBlock: async () => ({ hash: top, height: 100 }) } as any,
      identity,
    );
    (reader as any).contract = Promise.resolve({
      get_relationship: relation,
      get_lifecycle: lifecycle,
    });
    const result = await reader.relationship('ak_a', 'ak_b');
    expect(result).toMatchObject({
      block_hash: top,
      height: '100',
      importing: true,
      advisory: true,
      a_follows_b: true,
    });
    expect(relation).toHaveBeenCalledWith('ak_a', 'ak_b', {
      top,
      callStatic: true,
    });
    expect(lifecycle).toHaveBeenCalledWith({ top, callStatic: true });
    await expect(reader.relationship('bad', 'ak_b')).rejects.toThrow('Invalid');
  });
});

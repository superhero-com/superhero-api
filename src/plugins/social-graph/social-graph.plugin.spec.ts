// The relevance filter decides whether a tx is persisted at all. Live websocket
// payloads carry a ContractCallTx to the configured contract with contract_id
// and call_data but NO decoded `function`; the old predicate required
// `function` ∈ {follow,unfollow,block,unblock} and so dropped every follow at
// the tip before it ever reached the DB. These specs pin the fix: a configured-
// contract call is relevant on contract_id alone.
describe('SocialGraphPlugin.filters()', () => {
  const KEY = 'SOCIAL_GRAPH_CONTRACT_ADDRESS';
  const CONTRACT = 'ct_socialgraph';
  const original = process.env[KEY];

  beforeAll(() => {
    process.env[KEY] = CONTRACT;
  });

  afterAll(() => {
    if (original === undefined) {
      delete process.env[KEY];
    } else {
      process.env[KEY] = original;
    }
  });

  function loadPredicate() {
    let SocialGraphPlugin: any;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      SocialGraphPlugin = require('./social-graph.plugin').SocialGraphPlugin;
    });
    const plugin = new SocialGraphPlugin(
      undefined as any,
      undefined as any,
      undefined as any,
    );
    const filters = plugin.filters();
    expect(filters).toHaveLength(1);
    return { filter: filters[0], predicate: filters[0].predicate };
  }

  it('matches a configured-contract call that has NO decoded function (live payload)', () => {
    const { predicate } = loadPredicate();
    expect(predicate({ type: 'ContractCallTx', contract_id: CONTRACT })).toBe(
      true,
    );
  });

  it('still matches a call that does carry a decoded function (backward/mdw payload)', () => {
    const { predicate } = loadPredicate();
    expect(
      predicate({
        type: 'ContractCallTx',
        contract_id: CONTRACT,
        function: 'follow',
      }),
    ).toBe(true);
  });

  it('ignores calls to a different contract and non-contract-call txs', () => {
    const { predicate } = loadPredicate();
    expect(predicate({ type: 'ContractCallTx', contract_id: 'ct_other' })).toBe(
      false,
    );
    expect(predicate({ type: 'SpendTx', contract_id: CONTRACT })).toBe(false);
  });

  it('still advertises the graph functions and contract id as filter metadata', () => {
    const { filter } = loadPredicate();
    expect(filter.contractIds).toEqual([CONTRACT]);
    expect(filter.functions).toEqual([
      'follow',
      'unfollow',
      'block',
      'unblock',
    ]);
  });
});

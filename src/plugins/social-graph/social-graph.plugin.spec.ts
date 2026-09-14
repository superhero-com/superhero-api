// The relevance filter should accept any call to the configured contract,
// with or without a decoded `function`, so ingestion never depends on that
// field being present — event decode is the single place a call is classified.
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

  it('matches a configured-contract call whether or not it carries a function', () => {
    const { predicate } = loadPredicate();
    expect(predicate({ type: 'ContractCallTx', contract_id: CONTRACT })).toBe(
      true,
    );
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

  it('scopes the filter to the configured contract id', () => {
    const { filter } = loadPredicate();
    expect(filter.contractIds).toEqual([CONTRACT]);
  });
});

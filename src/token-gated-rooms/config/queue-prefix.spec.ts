import { prefixQueue, TGR_QUEUE_NAMES, TGR_QUEUE_OWNER } from './queue-prefix';

describe('prefixQueue', () => {
  const bases = [
    'publish-nip29',
    'room-backfill',
    'reconcile-balance',
    'reconcile-membership',
    'room-notify',
  ];

  it('exposes the five canonical base names verbatim', () => {
    expect(Object.values(TGR_QUEUE_NAMES).sort()).toEqual([...bases].sort());
  });

  it.each(bases)('prefixes "%s" with main:', (base) => {
    expect(prefixQueue(base, 'main')).toBe(`main:${base}`);
  });

  it.each(bases)('prefixes "%s" with worker:', (base) => {
    expect(prefixQueue(base, 'worker')).toBe(`worker:${base}`);
  });

  it('matches the §9 owner mapping (worker-consumed vs indexer-side)', () => {
    // Per plan §9: relay/publish/notify run in the worker; the AEX9 balance
    // sweep (reconcile-balance) is driven by the indexer (main).
    expect(TGR_QUEUE_OWNER['publish-nip29']).toBe('worker');
    expect(TGR_QUEUE_OWNER['room-backfill']).toBe('worker');
    expect(TGR_QUEUE_OWNER['reconcile-balance']).toBe('main');
    expect(TGR_QUEUE_OWNER['reconcile-membership']).toBe('worker');
    expect(TGR_QUEUE_OWNER['room-notify']).toBe('worker');
  });

  it('prefixes each queue using its §9 owner', () => {
    for (const [base, owner] of Object.entries(TGR_QUEUE_OWNER)) {
      expect(prefixQueue(base, owner)).toBe(`${owner}:${base}`);
    }
  });
});

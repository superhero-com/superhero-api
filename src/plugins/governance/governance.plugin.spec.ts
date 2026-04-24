import { GovernancePlugin } from './governance.plugin';
import { GovernancePollRegistry } from './services/governance-poll-registry.service';

const REGISTRY_CONTRACT = 'ct_registry' as const;

function buildPlugin(options: {
  contractAddress?: string | null;
  knownPolls?: string[];
}) {
  // `null` means "caller explicitly unset it"; absence means "use default".
  const effectiveAddress =
    options.contractAddress === null
      ? ''
      : (options.contractAddress ?? REGISTRY_CONTRACT);

  const configService = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'governance') {
        return {
          contract: { contractAddress: effectiveAddress },
        };
      }
      return undefined;
    }),
  } as any;

  const pollRegistry = {
    has: jest.fn(
      (addr: string | null | undefined) =>
        !!addr && (options.knownPolls ?? []).includes(addr),
    ),
    register: jest.fn(),
    size: jest.fn(() => (options.knownPolls ?? []).length),
    isLoaded: jest.fn(() => true),
  } as unknown as GovernancePollRegistry;

  const plugin = new GovernancePlugin(
    {} as any,
    {} as any,
    {} as any,
    configService,
    pollRegistry,
  );

  return { plugin, configService, pollRegistry };
}

describe('GovernancePlugin.filters()', () => {
  it('returns no filters when no registry contract is configured', () => {
    const { plugin } = buildPlugin({ contractAddress: null });
    expect(plugin.filters()).toEqual([]);
  });

  describe('predicate', () => {
    function predicateFor(knownPolls: string[] = []) {
      const { plugin } = buildPlugin({ knownPolls });
      const [filter] = plugin.filters();
      return filter.predicate!;
    }

    it('accepts ContractCallTx on the governance registry (any function)', () => {
      const predicate = predicateFor();
      expect(
        predicate({
          type: 'ContractCallTx',
          contract_id: REGISTRY_CONTRACT,
          function: 'add_poll',
        }),
      ).toBe(true);
      expect(
        predicate({
          type: 'ContractCallTx',
          contract_id: REGISTRY_CONTRACT,
          function: 'delegate',
        }),
      ).toBe(true);
      expect(
        predicate({
          type: 'ContractCallTx',
          contract_id: REGISTRY_CONTRACT,
          function: 'revoke_delegation',
        }),
      ).toBe(true);
    });

    it('accepts vote / revoke_vote only on a known poll contract', () => {
      const predicate = predicateFor(['ct_pollA']);

      expect(
        predicate({
          type: 'ContractCallTx',
          contract_id: 'ct_pollA',
          function: 'vote',
        }),
      ).toBe(true);
      expect(
        predicate({
          type: 'ContractCallTx',
          contract_id: 'ct_pollA',
          function: 'revoke_vote',
        }),
      ).toBe(true);

      expect(
        predicate({
          type: 'ContractCallTx',
          contract_id: 'ct_unrelated',
          function: 'vote',
        }),
      ).toBe(false);
      expect(
        predicate({
          type: 'ContractCallTx',
          contract_id: 'ct_unrelated',
          function: 'revoke_vote',
        }),
      ).toBe(false);
    });

    it('rejects generic governance function names on unrelated contracts', () => {
      // Regression test: matching by function alone would index arbitrary
      // contracts that expose `vote` / `delegate` / etc.
      const predicate = predicateFor([]);

      for (const fn of [
        'vote',
        'revoke_vote',
        'delegate',
        'revoke_delegation',
        'add_poll',
      ]) {
        expect(
          predicate({
            type: 'ContractCallTx',
            contract_id: 'ct_someRandomContract',
            function: fn,
          }),
        ).toBe(false);
      }
    });

    it('accepts ContractCreateTx only for known poll contracts', () => {
      const predicate = predicateFor(['ct_pollA']);

      expect(
        predicate({ type: 'ContractCreateTx', contract_id: 'ct_pollA' }),
      ).toBe(true);

      expect(
        predicate({
          type: 'ContractCreateTx',
          contract_id: 'ct_unrelatedContract',
        }),
      ).toBe(false);
    });

    it('rejects transactions without a contract_id', () => {
      const predicate = predicateFor(['ct_pollA']);

      expect(predicate({ type: 'ContractCallTx' })).toBe(false);
      expect(predicate({ type: 'ContractCreateTx' })).toBe(false);
      expect(predicate({ type: 'SpendTx' })).toBe(false);
    });

    it('rejects unrelated tx types even on the registry contract', () => {
      const predicate = predicateFor();

      expect(
        predicate({ type: 'SpendTx', contract_id: REGISTRY_CONTRACT as any }),
      ).toBe(false);
    });
  });
});

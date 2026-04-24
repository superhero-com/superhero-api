import { Plugin, PluginFilter } from '@/plugins/plugin.interface';
import { Tx } from '../entities/tx.entity';
import { PluginBatchProcessorService } from './plugin-batch-processor.service';
import { PluginRegistryService } from './plugin-registry.service';

/**
 * Dedicated coverage for the predicate-aggregation logic that decides whether
 * a transaction should be persisted at all. The processBatch / reorg paths
 * are covered elsewhere; here we only care about the pre-save gate.
 */
describe('PluginBatchProcessorService filtering', () => {
  const buildPlugin = (name: string, filters: PluginFilter[]): Plugin =>
    ({
      name,
      version: 1,
      filters: () => filters,
    }) as unknown as Plugin;

  const setup = (plugins: Plugin[]) => {
    const pluginRegistryService = {
      getPlugins: jest.fn(() => plugins),
    } as unknown as PluginRegistryService;

    const service = new PluginBatchProcessorService(
      pluginRegistryService,
      {} as any, // failedTransactionService (unused by the tested paths)
      {} as any, // pluginSyncStateRepository (unused by the tested paths)
    );

    return { service, pluginRegistryService };
  };

  const tx = (overrides: Partial<Tx>): Partial<Tx> => ({
    hash: 'th_default',
    ...overrides,
  });

  describe('filterRelevantTransactions', () => {
    it('returns [] when there are no transactions to check', () => {
      const { service } = setup([
        buildPlugin('p1', [{ predicate: () => true }]),
      ]);
      expect(service.filterRelevantTransactions([])).toEqual([]);
    });

    it('returns [] when no plugins are registered', () => {
      const { service } = setup([]);
      // Critical safety property: without any registered plugins we must
      // NEVER index anything. Otherwise a zero-plugin configuration would
      // quietly re-enable the legacy "index everything" behaviour.
      expect(
        service.filterRelevantTransactions([tx({ hash: 'th_1' })]),
      ).toEqual([]);
    });

    it('returns [] when plugins are registered but none expose a predicate', () => {
      const { service } = setup([
        buildPlugin('p1', [{ type: 'contract_call', contractIds: ['ct_abc'] }]),
        buildPlugin('p2', []),
      ]);
      // Filters without predicates must not leak through as "always match";
      // we index only what is explicitly claimed.
      expect(
        service.filterRelevantTransactions([
          tx({ hash: 'th_1', contract_id: 'ct_abc' }),
        ]),
      ).toEqual([]);
    });

    it('keeps only transactions matching at least one predicate (OR across plugins)', () => {
      const bclPredicate = jest.fn(
        (t: Partial<Tx>) =>
          t.type === 'ContractCallTx' && t.contract_id === 'ct_bcl',
      );
      const dexPredicate = jest.fn(
        (t: Partial<Tx>) =>
          t.type === 'ContractCallTx' && t.contract_id === 'ct_dex',
      );

      const { service } = setup([
        buildPlugin('bcl', [{ predicate: bclPredicate }]),
        buildPlugin('dex', [{ predicate: dexPredicate }]),
      ]);

      const txs = [
        tx({ hash: 'th_bcl', type: 'ContractCallTx', contract_id: 'ct_bcl' }),
        tx({ hash: 'th_dex', type: 'ContractCallTx', contract_id: 'ct_dex' }),
        tx({
          hash: 'th_other',
          type: 'ContractCallTx',
          contract_id: 'ct_unrelated',
        }),
      ];

      const result = service.filterRelevantTransactions(txs);

      expect(result.map((t) => t.hash)).toEqual(['th_bcl', 'th_dex']);
      expect(bclPredicate).toHaveBeenCalledTimes(3);
      expect(dexPredicate).toHaveBeenCalledTimes(2); // short-circuit: bcl match skips dex check
    });

    it('aggregates multiple filters from the same plugin with OR semantics', () => {
      const { service } = setup([
        buildPlugin('governance', [
          {
            predicate: (t: Partial<Tx>) => t.type === 'ContractCreateTx',
          },
          {
            predicate: (t: Partial<Tx>) =>
              t.type === 'ContractCallTx' && t.function === 'vote',
          },
        ]),
      ]);

      const txs = [
        tx({ hash: 'th_create', type: 'ContractCreateTx' }),
        tx({ hash: 'th_vote', type: 'ContractCallTx', function: 'vote' }),
        tx({
          hash: 'th_other',
          type: 'ContractCallTx',
          function: 'unrelated',
        }),
      ];

      expect(
        service.filterRelevantTransactions(txs).map((t) => t.hash),
      ).toEqual(['th_create', 'th_vote']);
    });

    it('preserves the input shape so extra metadata (block_height, etc.) flows through unchanged', () => {
      const { service } = setup([
        buildPlugin('p1', [
          { predicate: (t: Partial<Tx>) => t.hash === 'th_keep' },
        ]),
      ]);

      const input = [
        {
          hash: 'th_keep',
          block_height: 42,
          contract_id: 'ct_x',
        } as Partial<Tx>,
      ];
      const out = service.filterRelevantTransactions(input);

      // Same reference, not a cloned copy — the caller relies on
      // block_height and other fields being passed through.
      expect(out).toHaveLength(1);
      expect(out[0]).toBe(input[0]);
    });
  });

  describe('isRelevantTransaction', () => {
    it('returns false when no plugins are registered (never index by default)', () => {
      const { service } = setup([]);
      expect(service.isRelevantTransaction(tx({ hash: 'th_1' }))).toBe(false);
    });

    it('returns false when no predicate matches', () => {
      const { service } = setup([
        buildPlugin('bcl', [
          {
            predicate: (t: Partial<Tx>) => t.contract_id === 'ct_bcl',
          },
        ]),
      ]);
      expect(
        service.isRelevantTransaction(
          tx({ type: 'ContractCallTx', contract_id: 'ct_other' }),
        ),
      ).toBe(false);
    });

    it('returns true as soon as one predicate matches', () => {
      const matchingPredicate = jest.fn(() => true);
      const afterMatchPredicate = jest.fn(() => true);

      const { service } = setup([
        buildPlugin('p1', [{ predicate: matchingPredicate }]),
        buildPlugin('p2', [{ predicate: afterMatchPredicate }]),
      ]);

      expect(service.isRelevantTransaction(tx({}))).toBe(true);
      expect(matchingPredicate).toHaveBeenCalledTimes(1);
      // Short-circuit: once a predicate has claimed the tx, later predicates
      // should not be evaluated.
      expect(afterMatchPredicate).not.toHaveBeenCalled();
    });

    it('ignores filters that do not carry a predicate', () => {
      const { service } = setup([
        buildPlugin('p1', [
          { type: 'contract_call', contractIds: ['ct_abc'] }, // no predicate
        ]),
      ]);
      expect(
        service.isRelevantTransaction(
          tx({ type: 'ContractCallTx', contract_id: 'ct_abc' }),
        ),
      ).toBe(false);
    });
  });
});

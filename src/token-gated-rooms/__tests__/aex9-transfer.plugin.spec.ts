import { Aex9TransferPlugin } from '../plugins/aex9-transfer.plugin';
import { BalanceIndexerService } from '../services/balance-indexer.service';
import {
  AEX9_TRANSFER_PLUGIN_NAME,
  AEX9_TRANSFER_PLUGIN_VERSION,
} from '../plugins/aex9-transfer-sync.service';
import type { Tx } from '@/mdw-sync/entities/tx.entity';

/**
 * Unit coverage for the AEX9-transfer plugin shell (Task 03). The single
 * predicate filter must: accept an in-allowlist `ContractCallTx`, reject an
 * out-of-allowlist contract id, reject non-`ContractCallTx`, and reject a missing
 * `contract_id`. Mirrors `BclPlugin`'s predicate gating.
 */
describe('Aex9TransferPlugin', () => {
  const TOKEN = 'ct_in_allowlist';

  const makeIndexer = (allow: Set<string>): BalanceIndexerService =>
    ({
      isCommunityToken: (addr?: string | null) => !!addr && allow.has(addr),
    }) as unknown as BalanceIndexerService;

  const makePlugin = (allow: Set<string>): Aex9TransferPlugin =>
    new Aex9TransferPlugin(
      {} as any, // txRepository (unused by filters())
      {} as any, // pluginSyncStateRepository
      makeIndexer(allow),
      {} as any, // syncService
      { bufferAllPendingEvictions: jest.fn().mockResolvedValue(0) } as any, // reorgEviction
    );

  const predicate = (plugin: Aex9TransferPlugin) => {
    const filters = plugin.filters();
    expect(filters).toHaveLength(1);
    expect(typeof filters[0].predicate).toBe('function');
    return filters[0].predicate!;
  };

  it('exposes the canonical name + version', () => {
    const plugin = makePlugin(new Set());
    expect(plugin.name).toBe(AEX9_TRANSFER_PLUGIN_NAME);
    expect(plugin.version).toBe(AEX9_TRANSFER_PLUGIN_VERSION);
  });

  it('accepts an in-allowlist ContractCallTx', () => {
    const plugin = makePlugin(new Set([TOKEN]));
    const ok = predicate(plugin)({
      type: 'ContractCallTx',
      contract_id: TOKEN,
    } as Partial<Tx>);
    expect(ok).toBe(true);
  });

  it('rejects an out-of-allowlist contract id', () => {
    const plugin = makePlugin(new Set([TOKEN]));
    const ok = predicate(plugin)({
      type: 'ContractCallTx',
      contract_id: 'ct_not_in_allowlist',
    } as Partial<Tx>);
    expect(ok).toBe(false);
  });

  it('rejects a non-ContractCallTx (e.g. SpendTx) even if contract_id matches', () => {
    const plugin = makePlugin(new Set([TOKEN]));
    const ok = predicate(plugin)({
      type: 'SpendTx',
      contract_id: TOKEN,
    } as Partial<Tx>);
    expect(ok).toBe(false);
  });

  it('rejects a tx with no contract_id', () => {
    const plugin = makePlugin(new Set([TOKEN]));
    const ok = predicate(plugin)({
      type: 'ContractCallTx',
    } as Partial<Tx>);
    expect(ok).toBe(false);
  });
});

import { BigNumber } from 'bignumber.js';
import { Aex9TransferSyncService } from '../plugins/aex9-transfer-sync.service';
import { BalanceIndexerService } from '../services/balance-indexer.service';
import { AEX9_TRANSFER_PLUGIN_NAME } from '../plugins/aex9-transfer-sync.service';
import { SyncDirectionEnum } from '@/plugins/plugin.interface';
import type { Tx } from '@/mdw-sync/entities/tx.entity';

const TOKEN = 'ct_token';
const FROM = 'ak_from';
const TO = 'ak_to';

/** Build a Tx carrying pre-decoded plugin logs (the BasePlugin-persisted shape). */
function txWithTransfers(
  transfers: Array<{ name: string; args: unknown[] }>,
  overrides: Partial<Tx> = {},
): Tx {
  return {
    hash: 'th_test',
    type: 'ContractCallTx',
    contract_id: TOKEN,
    block_height: 100,
    raw: { log: [] },
    logs: {
      [AEX9_TRANSFER_PLUGIN_NAME]: { _version: 1, data: transfers },
    },
    data: undefined,
    ...overrides,
  } as unknown as Tx;
}

describe('Aex9TransferSyncService.processTransaction (balance apply)', () => {
  let indexer: jest.Mocked<
    Pick<
      BalanceIndexerService,
      'isCommunityToken' | 'applyDelta' | 'emitBalanceChanged'
    >
  >;
  let txRepository: { update: jest.Mock };
  let service: Aex9TransferSyncService;

  beforeEach(() => {
    indexer = {
      isCommunityToken: jest.fn().mockReturnValue(true),
      applyDelta: jest.fn(),
      emitBalanceChanged: jest.fn(),
    } as any;
    txRepository = { update: jest.fn().mockResolvedValue(undefined) };
    service = new Aex9TransferSyncService(
      {} as any, // aeSdkService
      indexer as unknown as BalanceIndexerService,
      txRepository as any,
    );
  });

  it('applies both legs of a single transfer (from decrement, to increment)', async () => {
    indexer.applyDelta
      .mockResolvedValueOnce(new BigNumber('500')) // from
      .mockResolvedValueOnce(new BigNumber('1500')); // to

    const tx = txWithTransfers([
      { name: 'Transfer', args: [FROM, TO, '1000'] },
    ]);
    await service.processTransaction(tx, SyncDirectionEnum.Live);

    expect(indexer.applyDelta).toHaveBeenCalledTimes(2);
    // from leg: negated value
    expect(indexer.applyDelta).toHaveBeenNthCalledWith(
      1,
      TOKEN,
      FROM,
      expect.objectContaining({}),
      100,
    );
    expect(indexer.applyDelta.mock.calls[0][2].toFixed()).toBe('-1000');
    // to leg: positive value
    expect(indexer.applyDelta.mock.calls[1][1]).toBe(TO);
    expect(indexer.applyDelta.mock.calls[1][2].toFixed()).toBe('1000');

    // both holders changed → both emitted
    expect(indexer.emitBalanceChanged).toHaveBeenCalledWith(TOKEN, FROM);
    expect(indexer.emitBalanceChanged).toHaveBeenCalledWith(TOKEN, TO);
  });

  it('ignores non-Transfer (Allowance) events — no balance moves', async () => {
    const tx = txWithTransfers([
      { name: 'Allowance', args: [FROM, TO, '1000'] },
    ]);
    await service.processTransaction(tx, SyncDirectionEnum.Live);
    expect(indexer.applyDelta).not.toHaveBeenCalled();
    expect(indexer.emitBalanceChanged).not.toHaveBeenCalled();
  });

  it('does not emit for a leg whose balance did not change (applyDelta → null)', async () => {
    indexer.applyDelta
      .mockResolvedValueOnce(null) // from unchanged (e.g. clamp no-op)
      .mockResolvedValueOnce(new BigNumber('1000')); // to changed

    const tx = txWithTransfers([
      { name: 'Transfer', args: [FROM, TO, '1000'] },
    ]);
    await service.processTransaction(tx, SyncDirectionEnum.Live);

    expect(indexer.emitBalanceChanged).toHaveBeenCalledTimes(1);
    expect(indexer.emitBalanceChanged).toHaveBeenCalledWith(TOKEN, TO);
  });

  it('is idempotent: a tx already marked _applied is a no-op', async () => {
    const tx = txWithTransfers(
      [{ name: 'Transfer', args: [FROM, TO, '1000'] }],
      {
        data: {
          [AEX9_TRANSFER_PLUGIN_NAME]: {
            _version: 1,
            data: { _applied: true },
          },
        },
      },
    );
    await service.processTransaction(tx, SyncDirectionEnum.Live);
    expect(indexer.applyDelta).not.toHaveBeenCalled();
    expect(indexer.emitBalanceChanged).not.toHaveBeenCalled();
  });

  it('marks the tx _applied after a successful apply (persisted via repo)', async () => {
    indexer.applyDelta.mockResolvedValue(new BigNumber('1'));
    const tx = txWithTransfers([
      { name: 'Transfer', args: [FROM, TO, '1000'] },
    ]);
    await service.processTransaction(tx, SyncDirectionEnum.Live);
    expect(tx.data?.[AEX9_TRANSFER_PLUGIN_NAME]?.data?._applied).toBe(true);
    expect(txRepository.update).toHaveBeenCalledWith(
      { hash: 'th_test' },
      { data: tx.data },
    );
  });

  it('skips a tx whose contract is no longer in the allowlist', async () => {
    indexer.isCommunityToken.mockReturnValue(false);
    const tx = txWithTransfers([
      { name: 'Transfer', args: [FROM, TO, '1000'] },
    ]);
    await service.processTransaction(tx, SyncDirectionEnum.Live);
    expect(indexer.applyDelta).not.toHaveBeenCalled();
  });

  it('ignores zero / non-positive transfer values', async () => {
    const tx = txWithTransfers([{ name: 'Transfer', args: [FROM, TO, '0'] }]);
    await service.processTransaction(tx, SyncDirectionEnum.Live);
    expect(indexer.applyDelta).not.toHaveBeenCalled();
  });
});

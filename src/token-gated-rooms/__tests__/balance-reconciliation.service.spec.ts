import { BigNumber } from 'bignumber.js';
import { BalanceReconciliationService } from '../services/balance-reconciliation.service';
import { BalanceIndexerService } from '../services/balance-indexer.service';

const TOKEN = 'ct_token';
const HOLDER = 'ak_holder';

/**
 * Unit coverage for the reconciliation sweep (Task 03). Repos/queue/SDK are
 * stubbed; the focus is the rotating-cursor batch + drift correction + emit.
 */
describe('BalanceReconciliationService.runOnce', () => {
  const makeService = (opts: {
    rows: Array<{
      token_address: string;
      holder_address: string;
      balance: BigNumber;
      updated_height: number;
    }>;
    authoritative: BigNumber | null;
    batchSize?: number;
  }) => {
    const qb = {
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(opts.rows),
    };
    const tokenBalanceRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const reconcileQueue = { add: jest.fn().mockResolvedValue(undefined) };
    const setAuthoritativeBalance = jest.fn();
    const emitBalanceChanged = jest.fn();
    const balanceIndexer = {
      setAuthoritativeBalance,
      emitBalanceChanged,
    } as unknown as BalanceIndexerService;
    const aeSdkService = {
      sdk: { getHeight: jest.fn().mockResolvedValue(12345) },
    };
    const config = {
      reconcileBatchSize: opts.batchSize ?? 500,
      reconcileIntervalSec: 600,
    };
    const service = new BalanceReconciliationService(
      tokenBalanceRepository as any,
      reconcileQueue as any,
      balanceIndexer,
      aeSdkService as any,
      config as any,
    );
    // stub the chain read directly (no real SDK)
    jest
      .spyOn(service, 'readAuthoritativeBalance')
      .mockResolvedValue(opts.authoritative);
    return {
      service,
      tokenBalanceRepository,
      setAuthoritativeBalance,
      emitBalanceChanged,
      qb,
    };
  };

  it('orders the batch by oldest last_reconciled_at and limits to batch size', async () => {
    const { service, qb } = makeService({
      rows: [],
      authoritative: new BigNumber('1'),
      batchSize: 250,
    });
    await service.runOnce();
    expect(qb.orderBy).toHaveBeenCalledWith(
      'tb.last_reconciled_at',
      'ASC',
      'NULLS FIRST',
    );
    expect(qb.take).toHaveBeenCalledWith(250);
  });

  it('corrects a drifted row, sets the authoritative value, and emits', async () => {
    const { service, setAuthoritativeBalance, emitBalanceChanged } =
      makeService({
        rows: [
          {
            token_address: TOKEN,
            holder_address: HOLDER,
            balance: new BigNumber('999'), // stored (drifted)
            updated_height: 10,
          },
        ],
        authoritative: new BigNumber('1000'), // true value on chain
      });
    setAuthoritativeBalance.mockResolvedValue(new BigNumber('1000')); // changed

    const corrected = await service.runOnce();

    expect(corrected).toBe(1);
    expect(setAuthoritativeBalance).toHaveBeenCalledWith(
      TOKEN,
      HOLDER,
      expect.any(BigNumber),
      12345, // tip height
    );
    expect(setAuthoritativeBalance.mock.calls[0][2].toFixed()).toBe('1000');
    expect(emitBalanceChanged).toHaveBeenCalledWith(TOKEN, HOLDER);
  });

  it('does not emit when the stored balance already matches chain (no drift)', async () => {
    const { service, setAuthoritativeBalance, emitBalanceChanged } =
      makeService({
        rows: [
          {
            token_address: TOKEN,
            holder_address: HOLDER,
            balance: new BigNumber('1000'),
            updated_height: 10,
          },
        ],
        authoritative: new BigNumber('1000'),
      });
    setAuthoritativeBalance.mockResolvedValue(null); // unchanged

    const corrected = await service.runOnce();

    expect(corrected).toBe(0);
    expect(emitBalanceChanged).not.toHaveBeenCalled();
  });

  it('skips overwrite (advances cursor only) when the chain read fails', async () => {
    const { service, tokenBalanceRepository, setAuthoritativeBalance } =
      makeService({
        rows: [
          {
            token_address: TOKEN,
            holder_address: HOLDER,
            balance: new BigNumber('1000'),
            updated_height: 10,
          },
        ],
        authoritative: null, // read failed
      });
    await service.runOnce();
    expect(setAuthoritativeBalance).not.toHaveBeenCalled();
    expect(tokenBalanceRepository.update).toHaveBeenCalledWith(
      { token_address: TOKEN, holder_address: HOLDER },
      expect.objectContaining({ last_reconciled_at: expect.any(Date) }),
    );
  });

  it('returns 0 with no rows', async () => {
    const { service } = makeService({ rows: [], authoritative: null });
    expect(await service.runOnce()).toBe(0);
  });
});

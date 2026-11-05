import 'dotenv/config';
import { Account } from '@/account/entities/account.entity';
import { AccountService } from '@/account/services/account.service';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { BclPlugin } from './bcl.plugin';

/**
 * Reorg cleanup against real Postgres: the DELETE ... RETURNING feeds the
 * account refresh, so the SQL itself is what needs checking. Skipped when no
 * DB host is set.
 */
const d = process.env.DB_HOST ? describe : describe.skip;

d('BclPlugin.onReorg (integration)', () => {
  let db: IsolatedDb;
  let accountService: AccountService;
  let plugin: BclPlugin;

  const trade = (
    hash: string,
    address: string,
    type: 'buy' | 'sell' | 'create_community',
    ae: string,
  ) =>
    db.dataSource.query(
      `INSERT INTO transactions
         (tx_hash, sale_address, tx_type, block_height, address, volume,
          amount, unit_price, buy_price, created_at)
       VALUES ($1, 'ct_sale', $2, 100, $3, 1, $4, '{}', '{}', now())`,
      [hash, type, address, JSON.stringify({ ae })],
    );

  const account = (address: string) =>
    db.dataSource.getRepository(Account).findOneByOrFail({ address });

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [Transaction, Account],
      migrations: [],
    });
    await db.dataSource.synchronize();
  }, 60_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.dataSource.query('TRUNCATE transactions, accounts');
    accountService = new AccountService(
      db.dataSource.getRepository(Account),
      db.dataSource.getRepository(Transaction),
    );
    plugin = new BclPlugin(
      {} as any,
      {} as any,
      db.dataSource.getRepository(Transaction),
      {} as any,
      accountService,
    );
    jest.spyOn((plugin as any).logger, 'log').mockImplementation(() => {});
  });

  it('deletes only the removed trades and recounts their traders', async () => {
    await trade('th_a1', 'ak_a', 'create_community', '2');
    await trade('th_a2', 'ak_a', 'buy', '3');
    await trade('th_b1', 'ak_b', 'buy', '4');
    await trade('th_c1', 'ak_c', 'sell', '5');
    for (const address of ['ak_a', 'ak_b', 'ak_c']) {
      await accountService.ensureAccountFromTransactions(address);
    }
    expect((await account('ak_a')).total_tx_count).toBe(2);

    await plugin.onReorg(['th_a2', 'th_b1', 'th_not_bcl']);

    const left = await db.dataSource.query(
      'SELECT tx_hash FROM transactions ORDER BY tx_hash',
    );
    expect(left.map((row: { tx_hash: string }) => row.tx_hash)).toEqual([
      'th_a1',
      'th_c1',
    ]);

    const a = await account('ak_a');
    expect(a.total_tx_count).toBe(1);
    expect(a.total_buy_tx_count).toBe(0);
    expect(a.total_created_tokens).toBe(1);
    expect(a.total_volume.toString()).toBe('2');

    // ak_b lost its only trade: the row stays, its totals drop to zero.
    const b = await account('ak_b');
    expect(b.total_tx_count).toBe(0);
    expect(b.total_buy_tx_count).toBe(0);
    expect(b.total_volume.toString()).toBe('0');

    const c = await account('ak_c');
    expect(c.total_tx_count).toBe(1);
    expect(c.total_volume.toString()).toBe('5');
  });
});

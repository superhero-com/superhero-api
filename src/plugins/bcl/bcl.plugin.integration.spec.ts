import 'dotenv/config';
import { Account } from '@/account/entities/account.entity';
import { AccountService } from '@/account/services/account.service';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { Token } from '@/tokens/entities/token.entity';
import { TokenTradeEligibilityCounts } from '@/tokens/entities/token-trade-eligibility-counts.entity';
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
    sale = 'ct_sale',
  ) =>
    db.dataSource.query(
      `INSERT INTO transactions
         (tx_hash, sale_address, tx_type, block_height, address, volume,
          amount, unit_price, buy_price, created_at)
       VALUES ($1, $5, $2, 100, $3, 1, $4, '{}', '{}', now())`,
      [hash, type, address, JSON.stringify({ ae }), sale],
    );

  const account = (address: string) =>
    db.dataSource.getRepository(Account).findOneByOrFail({ address });

  const token = async (sale: string, txCount: number, tradeCount: number) => {
    await db.dataSource.getRepository(Token).insert({
      sale_address: sale,
      name: sale,
      symbol: sale,
      tx_count: txCount,
      last_sync_tx_count: txCount,
    });
    await db.dataSource
      .getRepository(TokenTradeEligibilityCounts)
      .insert({ sale_address: sale, trade_count: tradeCount });
  };

  const counters = async (sale: string) => {
    const [row] = await db.dataSource.query(
      `SELECT t.tx_count, t.last_sync_tx_count, e.trade_count
       FROM token t
       JOIN token_trade_eligibility_counts e USING (sale_address)
       WHERE sale_address = $1`,
      [sale],
    );
    return row;
  };

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [Transaction, Account, Token, TokenTradeEligibilityCounts],
      migrations: [],
    });
    await db.dataSource.synchronize();
  }, 60_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.dataSource.query(
      'TRUNCATE transactions, accounts, token, token_trade_eligibility_counts',
    );
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

  it('rolls back the token counters the removed trades fed', async () => {
    await trade('th_x0', 'ak_a', 'create_community', '1', 'ct_x');
    await trade('th_x1', 'ak_a', 'buy', '1', 'ct_x');
    await trade('th_x2', 'ak_b', 'sell', '1', 'ct_x');
    await trade('th_x3', 'ak_b', 'buy', '1', 'ct_x');
    await trade('th_y1', 'ak_c', 'buy', '1', 'ct_y');
    await token('ct_x', 4, 3);
    await token('ct_y', 1, 1);

    await plugin.onReorg(['th_x0', 'th_x1']);

    // The create is not a trade, so the eligibility count loses only the buy.
    const ctX = { tx_count: 2, last_sync_tx_count: 2, trade_count: 2 };
    expect(await counters('ct_x')).toEqual(ctX);
    expect(await counters('ct_y')).toEqual({
      tx_count: 1,
      last_sync_tx_count: 1,
      trade_count: 1,
    });

    // A repeated cleanup deletes nothing, so it must not roll back again.
    await plugin.onReorg(['th_x0', 'th_x1']);
    expect(await counters('ct_x')).toEqual(ctX);
  });
});

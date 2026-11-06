import 'dotenv/config';
import BigNumber from 'bignumber.js';
import { DataSource } from 'typeorm';
import { BCL_FUNCTIONS } from '@/configs';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { Token } from '@/tokens/entities/token.entity';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import { TokenHolderService } from './token-holder.service';

const d = process.env.DB_HOST ? describe : describe.skip;

d('TokenHolderService.updateTokenHolder (integration)', () => {
  const HOLDER_ID = 'ak_buyer_ct_token';
  let db: IsolatedDb;
  let ds: DataSource;
  let service: TokenHolderService;

  const token = (holdersCount: number) =>
    ({
      sale_address: 'ct_sale',
      address: 'ct_token',
      holders_count: holdersCount,
    }) as Token;

  const buy = (hash: string, height: number) =>
    ({
      function: BCL_FUNCTIONS.buy,
      caller_id: 'ak_buyer',
      hash,
      block_height: height,
    }) as Tx;

  const insertHolderSql = `INSERT INTO token_holder (id, aex9_address, address, balance, last_tx_hash, block_number)
     VALUES ($1, 'ct_token', 'ak_buyer', '2000000000000000000', 'th_first', 10)`;

  const holders = () =>
    ds.query(`SELECT id, balance, last_tx_hash FROM token_holder`);

  const holdersCount = async () =>
    (await ds.getRepository(Token).findOneByOrFail({ sale_address: 'ct_sale' }))
      .holders_count;

  async function waitForLockWait(): Promise<boolean> {
    for (let i = 0; i < 200; i++) {
      const [{ waiting }] = await ds.query(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (waiting > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      migrations: [],
      entities: [Token, TokenHolder],
    });
    ds = db.dataSource;
    await ds.synchronize();
    service = new TokenHolderService(
      ds.getRepository(TokenHolder),
      { update: jest.fn(), loadAndSaveTokenHoldersFromMdw: jest.fn() } as any,
      {
        applyDelta: jest.fn().mockResolvedValue(null),
        emitBalanceChanged: jest.fn(),
      } as any,
    );
  }, 60_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  beforeEach(async () => {
    await ds.query('DELETE FROM token_holder');
    await ds.query('DELETE FROM token');
    await ds.getRepository(Token).insert({
      ...token(0),
      name: 'Token',
      symbol: 'TKN',
    });
  });

  it('adds a first buy to a holder row inserted under it instead of failing the trade', async () => {
    const blocker = ds.createQueryRunner();
    await blocker.connect();
    try {
      await blocker.startTransaction();
      await blocker.query(insertHolderSql, [HOLDER_ID]);

      // The uncommitted row is invisible to the lookup, so the service reaches
      // its insert, which has to wait for the blocker's outcome.
      const trade = ds.transaction((manager) =>
        service.updateTokenHolder(
          token(0),
          buy('th_second', 11),
          new BigNumber(3),
          manager,
        ),
      );
      const waited = await waitForLockWait();
      await blocker.commitTransaction();
      await trade;

      expect(waited).toBe(true);
    } finally {
      await blocker.release();
    }

    expect(await holders()).toEqual([
      {
        id: HOLDER_ID,
        balance: '5000000000000000000',
        last_tx_hash: 'th_second',
      },
    ]);
    expect(await holdersCount()).toBe(1);
  });

  it('applies two concurrent buys by one wallet one after the other', async () => {
    await ds.query(insertHolderSql, [HOLDER_ID]);
    const first = ds.createQueryRunner();
    await first.connect();
    try {
      await first.startTransaction();
      await service.updateTokenHolder(
        token(1),
        buy('th_second', 11),
        new BigNumber(3),
        first.manager,
      );

      // Without the row lock this reads the committed 2 and writes 2 + 4,
      // dropping the first buy.
      const second = ds.transaction((manager) =>
        service.updateTokenHolder(
          token(1),
          buy('th_third', 12),
          new BigNumber(4),
          manager,
        ),
      );
      const waited = await waitForLockWait();
      await first.commitTransaction();
      await second;

      expect(waited).toBe(true);
    } finally {
      await first.release();
    }

    expect(await holders()).toEqual([
      {
        id: HOLDER_ID,
        balance: '9000000000000000000',
        last_tx_hash: 'th_third',
      },
    ]);
  });

  it('adds a buy to an existing holder row outside a transaction', async () => {
    // The row lock needs a transaction, so this would throw if it were taken.
    await ds.query(insertHolderSql, [HOLDER_ID]);

    await service.updateTokenHolder(
      token(1),
      buy('th_second', 11),
      new BigNumber(3),
    );

    expect(await holders()).toEqual([
      {
        id: HOLDER_ID,
        balance: '5000000000000000000',
        last_tx_hash: 'th_second',
      },
    ]);
  });
});

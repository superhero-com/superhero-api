import 'dotenv/config';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { Token } from '@/tokens/entities/token.entity';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { BCL_FUNCTIONS } from '@/configs';
import { EntityManager } from 'typeorm';
import { SyncDirectionEnum } from '../../plugin.interface';
import { TransactionPersistenceService } from './transaction-persistence.service';
import { TransactionProcessorService } from './transaction-processor.service';

const d = process.env.DB_HOST ? describe : describe.skip;

d('BCL transaction lock ordering', () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      migrations: [],
      entities: [],
      seedSql: [
        'CREATE TABLE token (sale_address text PRIMARY KEY, tx_count int NOT NULL DEFAULT 0, metadata_updates int NOT NULL DEFAULT 0)',
        'CREATE TABLE transactions (tx_hash text PRIMARY KEY, sale_address text NOT NULL)',
        "INSERT INTO token (sale_address) VALUES ('ct_sale')",
      ],
    });
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('serializes replay before metadata and persists one transaction without a lock cycle', async () => {
    // Keep real processor/persistence transactions and PostgreSQL locks. The
    // adapters supply only the columns this flow needs, without chain calls.
    const wrapManager = (manager: EntityManager): EntityManager => {
      const transactions = {
        exists: async ({ where }) => {
          const [{ found }] = await manager.query(
            'SELECT EXISTS(SELECT 1 FROM transactions WHERE tx_hash=$1) AS found',
            [where.tx_hash],
          );
          return found;
        },
        upsert: async (data) =>
          manager.query(
            'INSERT INTO transactions VALUES ($1,$2) ON CONFLICT(tx_hash) DO UPDATE SET sale_address=excluded.sale_address',
            [data.tx_hash, data.sale_address],
          ),
        findOne: async ({ where }) =>
          (
            await manager.query('SELECT * FROM transactions WHERE tx_hash=$1', [
              where.tx_hash,
            ])
          )[0],
        count: async ({ where }) =>
          Number(
            (
              await manager.query(
                'SELECT count(*) FROM transactions WHERE sale_address=$1',
                [where.sale_address],
              )
            )[0].count,
          ),
      };
      const tokens = {
        update: async (address, data) =>
          manager.query('UPDATE token SET tx_count=$1 WHERE sale_address=$2', [
            data.tx_count,
            address,
          ]),
      };
      return new Proxy(manager, {
        get(target, key) {
          if (key === 'getRepository')
            return (entity) => {
              if (entity === Transaction) return transactions;
              if (entity === Token) return tokens;
              throw new Error('Unexpected repository');
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    let releaseFirst: () => void;
    let firstPrepared: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const prepared = new Promise<void>((resolve) => {
      firstPrepared = resolve;
    });
    const tx = { hash: 'th_replay', function: BCL_FUNCTIONS.create_community };
    const token = { sale_address: 'ct_sale', factory_address: 'ct_factory' };
    const persistence = new TransactionPersistenceService({} as any);
    jest.spyOn(persistence, 'cleanupOldTransactions').mockResolvedValue([]);
    const getToken = jest
      .fn()
      .mockResolvedValueOnce({ ...token, factory_address: null })
      .mockResolvedValue(token);
    const prepare = jest
      .fn()
      .mockImplementationOnce(async () => {
        firstPrepared();
        await held;
        return { tx_hash: tx.hash, sale_address: token.sale_address };
      })
      .mockResolvedValue({
        tx_hash: tx.hash,
        sale_address: token.sale_address,
      });
    const processor = new TransactionProcessorService(
      {
        validateTransaction: async () => ({
          isValid: true,
          saleAddress: token.sale_address,
        }),
      } as any,
      { calculatePrices: () => ({}), prepareTransactionData: prepare } as any,
      persistence,
      {
        decodeTxEvents: async () => tx,
        parseTransactionData: async () => ({}),
        isTokenSupportedCollection: async () => false,
      } as any,
      {
        getToken,
        findByAddress: async () => token,
        updateTokenMetaDataFromCreateTx: async (_token, _tx, manager) =>
          manager.query(
            'UPDATE token SET metadata_updates=metadata_updates+1 WHERE sale_address=$1',
            [token.sale_address],
          ),
      } as any,
      {} as any,
      {
        manager: {
          transaction: async (work) =>
            db.dataSource.transaction(async (manager) => {
              await manager.query("SET LOCAL statement_timeout='5s'");
              return work(wrapManager(manager));
            }),
        },
      } as any,
    );
    const first = processor.processTransaction(
      tx as any,
      SyncDirectionEnum.Backward,
    );
    let second: ReturnType<typeof processor.processTransaction> | undefined;
    try {
      await prepared;
      second = processor.processTransaction(
        tx as any,
        SyncDirectionEnum.Backward,
      );
      // Observe an actual waiting lock, rather than assuming a timer means
      // the second transaction has reached the contested operation.
      const deadline = Date.now() + 3_000;
      let blocked = false;
      while (Date.now() < deadline && !blocked) {
        const [{ waiting }] = await db.dataSource.query(
          "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
        );
        blocked = waiting > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      expect(getToken).toHaveBeenCalledTimes(1);
    } finally {
      releaseFirst();
      const results = await Promise.allSettled([
        first,
        ...(second ? [second] : []),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    }
    expect(await db.dataSource.query('SELECT * FROM transactions')).toEqual([
      { tx_hash: tx.hash, sale_address: token.sale_address },
    ]);
    expect(
      await db.dataSource.query('SELECT tx_count,metadata_updates FROM token'),
    ).toEqual([{ tx_count: 1, metadata_updates: 1 }]);
  }, 15_000);
});

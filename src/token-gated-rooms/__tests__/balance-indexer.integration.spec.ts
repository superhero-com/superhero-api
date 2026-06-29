import 'dotenv/config';
import { BigNumber } from 'bignumber.js';
import { DataSource, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DATABASE_CONFIG } from '@/configs/database';
import { Token } from '@/tokens/entities/token.entity';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { TokenBalance } from '../entities/token-balance.entity';
import { BalanceIndexerService } from '../services/balance-indexer.service';
import { BalanceReconciliationService } from '../services/balance-reconciliation.service';
import { Aex9TransferSyncService } from '../plugins/aex9-transfer-sync.service';
import { AEX9_TRANSFER_PLUGIN_NAME } from '../plugins/aex9-transfer-sync.service';
import { TGR_BALANCE_CHANGED } from '../events';
import { TGR_COMMUNITY_UPSERTED } from '../events';
import { SyncDirectionEnum } from '@/plugins/plugin.interface';

/**
 * DB integration (Task 03, Task 02 harness style). Drives the real
 * `BalanceIndexerService` / `Aex9TransferSyncService` / `BalanceReconciliationService`
 * against a live Postgres `token_balance` table. Requires `DB_HOST` (repo `.env`);
 * skipped automatically otherwise so unit-only runs stay green.
 *
 * The `token_balance` table is ensured via raw DDL (idempotent) so the test does
 * not depend on the app having run its migrations, and rows are scoped to a unique
 * test token id then cleaned up.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

const TEST_TOKEN = 'ct_tgr03_int_token';
const TEST_SALE = 'ct_tgr03_int_sale';
const FROM = 'ak_tgr03_from';
const TO = 'ak_tgr03_to';
const config: any = {
  communityTokenRefreshSec: 300,
  reconcileBatchSize: 500,
  reconcileIntervalSec: 600,
};

d('AEX9 balance indexer (integration)', () => {
  let ds: DataSource;
  let tokenBalanceRepo: Repository<TokenBalance>;
  let tokenRepo: Repository<Token>;
  let txRepo: Repository<Tx>;
  let emitter: EventEmitter2;

  beforeAll(async () => {
    ds = new DataSource({
      ...(DATABASE_CONFIG as any),
      synchronize: false,
      entities: [Token, Tx, TokenBalance],
    });
    await ds.initialize();
    // Ensure the table exists (idempotent) so the test is self-contained.
    await ds.query(`
      CREATE TABLE IF NOT EXISTS "token_balance" (
        "token_address" character varying NOT NULL,
        "holder_address" character varying NOT NULL,
        "balance" numeric NOT NULL DEFAULT 0,
        "updated_height" integer NOT NULL DEFAULT 0,
        "last_reconciled_at" timestamptz,
        CONSTRAINT "PK_token_balance" PRIMARY KEY ("token_address", "holder_address")
      )
    `);
    tokenBalanceRepo = ds.getRepository(TokenBalance);
    tokenRepo = ds.getRepository(Token);
    txRepo = ds.getRepository(Tx);
    emitter = new EventEmitter2();
  }, 60_000);

  afterEach(async () => {
    await tokenBalanceRepo.delete({ token_address: TEST_TOKEN });
    await tokenRepo.delete({ sale_address: TEST_SALE }).catch(() => undefined);
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
  });

  const makeIndexer = () =>
    new BalanceIndexerService(tokenRepo, tokenBalanceRepo, emitter, config);

  it('indexes a Transfer into token_balance rows in raw base units, sets height, emits', async () => {
    const indexer = makeIndexer();
    indexer.addToAllowlist(TEST_TOKEN);

    const sync = new Aex9TransferSyncService({} as any, indexer, txRepo);

    const changed: Array<{ tokenAddress: string; holderAddress: string }> = [];
    emitter.on(TGR_BALANCE_CHANGED, (p: any) => changed.push(p));

    // Seed sender with a starting balance so the from-leg has something to debit.
    await tokenBalanceRepo.save(
      tokenBalanceRepo.create({
        token_address: TEST_TOKEN,
        holder_address: FROM,
        balance: new BigNumber('5000000000000000000'), // 5 @ 18 decimals
        updated_height: 1,
      }),
    );

    // A real-shaped pre-decoded Transfer of 2 @ 18 decimals (raw base units).
    const tx = {
      hash: 'th_tgr03_transfer',
      type: 'ContractCallTx',
      contract_id: TEST_TOKEN,
      block_height: 4242,
      raw: { log: [] },
      logs: {
        [AEX9_TRANSFER_PLUGIN_NAME]: {
          _version: 1,
          data: [
            {
              name: 'Transfer',
              args: [FROM, TO, '2000000000000000000'],
            },
          ],
        },
      },
    } as unknown as Tx;
    // Persist the tx so the _applied marker update has a row to touch.
    await txRepo.save({
      ...tx,
      block_hash: 'mh_tgr03',
      micro_index: '0',
      micro_time: '0',
      signatures: [],
    } as any);

    await sync.processTransaction(tx, SyncDirectionEnum.Live);

    const fromRow = await tokenBalanceRepo.findOneByOrFail({
      token_address: TEST_TOKEN,
      holder_address: FROM,
    });
    const toRow = await tokenBalanceRepo.findOneByOrFail({
      token_address: TEST_TOKEN,
      holder_address: TO,
    });

    expect(fromRow.balance.toFixed()).toBe('3000000000000000000'); // 5 - 2
    expect(toRow.balance.toFixed()).toBe('2000000000000000000'); // 0 + 2
    expect(toRow.updated_height).toBe(4242);

    const holders = changed.map((c) => c.holderAddress).sort();
    expect(holders).toEqual([FROM, TO].sort());
    for (const c of changed) {
      expect(c.tokenAddress).toBe(TEST_TOKEN);
    }

    await txRepo.delete({ hash: 'th_tgr03_transfer' }).catch(() => undefined);
  }, 60_000);

  it('reconciliation corrects a drifted balance, advances last_reconciled_at, emits', async () => {
    const indexer = makeIndexer();

    // Seed a drifted row.
    await tokenBalanceRepo.save(
      tokenBalanceRepo.create({
        token_address: TEST_TOKEN,
        holder_address: TO,
        balance: new BigNumber('111'), // wrong
        updated_height: 1,
        last_reconciled_at: new Date('2000-01-01T00:00:00Z'),
      }),
    );

    const aeSdkService = {
      sdk: { getHeight: jest.fn().mockResolvedValue(99999) },
    } as any;
    const reconciler = new BalanceReconciliationService(
      tokenBalanceRepo,
      { add: jest.fn() } as any,
      indexer,
      aeSdkService,
      config,
    );
    // Stub the chain read to the TRUE value.
    jest
      .spyOn(reconciler, 'readAuthoritativeBalance')
      .mockResolvedValue(new BigNumber('1000'));

    const changed: any[] = [];
    emitter.on(TGR_BALANCE_CHANGED, (p) => changed.push(p));

    const corrected = await reconciler.runOnce();
    expect(corrected).toBeGreaterThanOrEqual(1);

    const row = await tokenBalanceRepo.findOneByOrFail({
      token_address: TEST_TOKEN,
      holder_address: TO,
    });
    expect(row.balance.toFixed()).toBe('1000');
    expect(row.updated_height).toBe(99999);
    expect(row.last_reconciled_at.getTime()).toBeGreaterThan(
      new Date('2000-01-02T00:00:00Z').getTime(),
    );
    expect(
      changed.some(
        (c) => c.tokenAddress === TEST_TOKEN && c.holderAddress === TO,
      ),
    ).toBe(true);
  }, 60_000);

  it('allowlist refresh: tgr.community.upserted makes a new token indexable', async () => {
    const indexer = makeIndexer();
    await indexer.refreshAllowlist();
    expect(indexer.isCommunityToken(TEST_TOKEN)).toBe(false);

    // Insert a minimal Token row via raw SQL so the test does not depend on the
    // Task-00 TGR columns being migrated into the live `token` table (the
    // allowlist only reads `address`; a full entity save would SELECT all cols).
    await ds.query(
      `INSERT INTO "token" ("sale_address","address","name","symbol")
       VALUES ($1,$2,$3,$4)
       ON CONFLICT ("sale_address") DO UPDATE SET "address" = EXCLUDED."address"`,
      [TEST_SALE, TEST_TOKEN, 'TGR03', 'TGR03'],
    );

    await indexer.onCommunityUpserted({ saleAddress: TEST_SALE });
    expect(indexer.isCommunityToken(TEST_TOKEN)).toBe(true);

    // And a full refresh from DB also picks it up.
    const indexer2 = makeIndexer();
    await indexer2.refreshAllowlist();
    expect(indexer2.isCommunityToken(TEST_TOKEN)).toBe(true);

    // sanity: TGR_COMMUNITY_UPSERTED is the canonical name we listen on
    expect(TGR_COMMUNITY_UPSERTED).toBe('tgr.community.upserted');
  }, 60_000);
});

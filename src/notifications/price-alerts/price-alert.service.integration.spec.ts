import 'dotenv/config';
import { NotFoundException } from '@nestjs/common';
import { BaseSchema1718900000000 } from '@/migrations/1718900000000-BaseSchema';
import { TokenPriceAlerts1718900000038 } from '@/migrations/1718900000038-TokenPriceAlerts';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { Token } from '@/tokens/entities/token.entity';
import { TokenPriceAlert } from '../entities/token-price-alert.entity';
import {
  PRICE_ALERT_MAX_ACTIVE,
  PriceAlertService,
} from './price-alert.service';

// The alert SQL is raw and unqualified, so it needs a throwaway database, not a
// schema (same reasoning as notification-feed.service.prune.integration.spec).
const d = process.env.DB_HOST ? describe : describe.skip;

d('PriceAlertService (integration)', () => {
  let db: IsolatedDb;
  let send: jest.Mock;
  let service: PriceAlertService;

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [TokenPriceAlert, Token],
      migrations: [BaseSchema1718900000000, TokenPriceAlerts1718900000038],
    });
    await db.dataSource.runMigrations();
  }, 60_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  beforeEach(() => {
    send = jest.fn().mockResolvedValue({ outcome: 'sent' });
    service = new PriceAlertService(
      db.dataSource.getRepository(TokenPriceAlert),
      db.dataSource.getRepository(Token),
      { send } as any,
    );
  });

  afterEach(async () => {
    await db.dataSource.query('DELETE FROM token_price_alerts');
    await db.dataSource.query('DELETE FROM token');
  });

  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  async function token(sale: string, price: string, symbol = sale) {
    await db.dataSource.query(
      'INSERT INTO token (sale_address, name, symbol, price) VALUES ($1, $1, $2, $3)',
      [sale, symbol, price],
    );
  }

  async function alert(row: {
    sale: string;
    direction: 'above' | 'below';
    target: string;
    address?: string;
    createdAt?: Date;
    triggeredAt?: Date | null;
  }): Promise<number> {
    const [{ id }] = await db.dataSource.query(
      `INSERT INTO token_price_alerts
         (address, sale_address, direction, target_ae, created_at, triggered_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        row.address ?? 'ak_alice',
        row.sale,
        row.direction,
        row.target,
        row.createdAt ?? new Date(),
        row.triggeredAt ?? null,
      ],
    );
    return id;
  }

  /** Bulk-insert alerts that fired just now, created one second apart. */
  async function firedAlerts(address: string, sale: string, count: number) {
    await db.dataSource.query(
      `INSERT INTO token_price_alerts
         (address, sale_address, direction, target_ae, created_at, triggered_at)
       SELECT $1, $2, 'above', 5, now() - g * interval '1 second', now()
         FROM generate_series(1, $3::int) g`,
      [address, sale, count],
    );
  }

  async function firedIds(): Promise<number[]> {
    const rows = await db.dataSource.query(
      'SELECT id FROM token_price_alerts WHERE triggered_at IS NOT NULL ORDER BY id',
    );
    return rows.map((r: { id: number }) => r.id);
  }

  describe('checkAlerts', () => {
    it('fires each crossed alert exactly once', async () => {
      await token('ct_up', '2', 'UP');
      await token('ct_low', '0.5', 'LOW');
      await token('ct_unpriced', '0');
      const atTarget = await alert({
        sale: 'ct_up',
        direction: 'above',
        target: '2',
      });
      await alert({ sale: 'ct_up', direction: 'above', target: '3' });
      const below = await alert({
        sale: 'ct_low',
        direction: 'below',
        target: '1',
      });
      // Would fire if the join matched another token's price.
      await alert({ sale: 'ct_up', direction: 'below', target: '1' });
      // A price of 0 means the indexer has no price yet.
      await alert({ sale: 'ct_unpriced', direction: 'below', target: '1' });
      const alreadyFired = await alert({
        sale: 'ct_low',
        direction: 'below',
        target: '1',
        triggeredAt: daysAgo(1),
      });

      expect(await service.checkAlerts()).toBe(2);

      const sent = send.mock.calls.map(([, n]) => n.toExpo());
      expect(sent.map((m) => m.data.alertId).sort()).toEqual(
        [atTarget, below].sort(),
      );
      expect(sent.find((m) => m.data.alertId === atTarget).body).toBe(
        'UP is above 2 AE (now 2 AE)',
      );
      expect(await firedIds()).toEqual(
        [atTarget, below, alreadyFired].sort((a, b) => a - b),
      );

      expect(await service.checkAlerts()).toBe(0);
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  describe('listFor', () => {
    it("lists the account's active alerts ahead of 100 newer fired ones", async () => {
      await token('ct_up', '2', 'UP');
      const active = await alert({
        sale: 'ct_up',
        direction: 'above',
        target: '3',
        createdAt: daysAgo(10),
      });
      await firedAlerts('ak_alice', 'ct_up', 100);
      const bobs = await alert({
        address: 'ak_bob',
        sale: 'ct_up',
        direction: 'above',
        target: '3',
      });

      const list = await service.listFor('ak_alice');

      expect(list).toHaveLength(100);
      expect(list[0]).toMatchObject({
        id: active,
        symbol: 'UP',
        triggered_at: null,
      });
      expect(list.slice(1).every((a) => a.triggered_at !== null)).toBe(true);
      expect(list.map((a) => a.id)).not.toContain(bobs);
    });
  });

  describe('create', () => {
    it("caps only the account's own active alerts", async () => {
      await token('ct_up', '2');
      await firedAlerts('ak_alice', 'ct_up', PRICE_ALERT_MAX_ACTIVE);
      for (let i = 1; i < PRICE_ALERT_MAX_ACTIVE; i += 1) {
        await alert({ sale: 'ct_up', direction: 'above', target: '3' });
        await alert({
          address: 'ak_bob',
          sale: 'ct_up',
          direction: 'above',
          target: '3',
        });
      }
      await alert({
        address: 'ak_bob',
        sale: 'ct_up',
        direction: 'above',
        target: '3',
      });

      const created = await service.create('ak_alice', 'ct_up', 'below', '1.5');
      const [row] = await db.dataSource.query(
        'SELECT address, sale_address, direction, target_ae::text AS target_ae, triggered_at FROM token_price_alerts WHERE id = $1',
        [created.id],
      );
      expect(row).toEqual({
        address: 'ak_alice',
        sale_address: 'ct_up',
        direction: 'below',
        target_ae: '1.5',
        triggered_at: null,
      });

      await expect(
        service.create('ak_alice', 'ct_up', 'above', '3'),
      ).rejects.toMatchObject({ status: 429 });
    });
  });

  describe('remove', () => {
    it("never deletes another account's alert", async () => {
      await token('ct_up', '2');
      const id = await alert({
        sale: 'ct_up',
        direction: 'above',
        target: '3',
      });

      await expect(service.remove('ak_bob', id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await service.remove('ak_alice', id);

      const rows = await db.dataSource.query(
        'SELECT id FROM token_price_alerts',
      );
      expect(rows).toEqual([]);
    });
  });

  describe('pruneFired', () => {
    it('drops alerts fired over 30 days ago and keeps the rest', async () => {
      await token('ct_up', '2');
      await alert({
        sale: 'ct_up',
        direction: 'above',
        target: '1',
        triggeredAt: daysAgo(31),
      });
      const recent = await alert({
        sale: 'ct_up',
        direction: 'above',
        target: '1',
        triggeredAt: daysAgo(29),
      });
      const oldActive = await alert({
        sale: 'ct_up',
        direction: 'above',
        target: '3',
        createdAt: daysAgo(40),
      });

      await service.pruneFired();

      const rows = await db.dataSource.query(
        'SELECT id FROM token_price_alerts ORDER BY id',
      );
      expect(rows.map((r: { id: number }) => r.id)).toEqual([
        recent,
        oldActive,
      ]);
    });
  });
});

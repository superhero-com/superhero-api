import { NotificationFeedService } from './notification-feed.service';

/** Chainable query-builder stub: every builder method returns `this`. */
function makeQb(result: { getMany?: any; execute?: any }) {
  const qb: any = {};
  for (const m of ['where', 'andWhere', 'orderBy', 'take', 'update', 'set']) {
    qb[m] = jest.fn(() => qb);
  }
  qb.getMany = jest.fn().mockResolvedValue(result.getMany ?? []);
  qb.execute = jest.fn().mockResolvedValue(result.execute ?? { affected: 0 });
  return qb;
}

describe('NotificationFeedService', () => {
  let repo: any;
  let service: NotificationFeedService;

  beforeEach(() => {
    repo = {
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
      manager: { query: jest.fn() },
    };
    service = new NotificationFeedService(repo);
  });

  describe('recordAndCountUnread', () => {
    const rowFixture = (over: Partial<any> = {}) => ({
      id: 12,
      address: 'ak_owner',
      type: 'post-comment',
      title: 't',
      body: 'b',
      data: null,
      read_at: null,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      unread_count: 3,
      ...over,
    });

    it('inserts and counts unread in ONE round-trip (no separate query)', async () => {
      // The whole point of this method: a SEPARATE record() + unreadCount()
      // pair has an await gap between the write and the read, during which a
      // concurrent markRead() can complete its own write+emit — so a
      // separately-read count could go stale before it's finally emitted,
      // overwriting markRead's correct badge. Fusing both into one statement
      // closes that window, so this asserts there is exactly ONE DB call.
      repo.manager.query.mockResolvedValue([rowFixture()]);

      await service.recordAndCountUnread('ak_owner', 'post-comment', {
        title: 't',
        body: 'b',
      });

      expect(repo.manager.query).toHaveBeenCalledTimes(1);
    });

    it('passes address/type/title/body/data as params, with a NULL data param when absent', async () => {
      repo.manager.query.mockResolvedValue([rowFixture()]);

      await service.recordAndCountUnread('ak_owner', 'post-comment', {
        title: 't',
        body: 'b',
      });

      const [sql, params] = repo.manager.query.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO notifications/i);
      expect(sql).toMatch(/RETURNING/i);
      expect(sql).toMatch(/read_at IS NULL/i); // the unread subquery predicate
      // Regression guard for the CTE-snapshot undercount: a data-modifying CTE's
      // effects are invisible to the rest of the query except via RETURNING, so
      // the count subquery can't see the row `ins` just inserted and must add 1
      // for it explicitly (proven against real Postgres in the sibling
      // *.record-and-count.integration.spec.ts).
      expect(sql).toMatch(/\)\s*\+\s*1\s+AS\s+unread_count/i);
      expect(params).toEqual(['ak_owner', 'post-comment', 't', 'b', null]);
    });

    it('JSON-stringifies a present data payload for the jsonb column', async () => {
      repo.manager.query.mockResolvedValue([rowFixture()]);

      await service.recordAndCountUnread('ak_owner', 'post-comment', {
        title: 't',
        body: 'b',
        data: { txHash: 'th_1' },
      });

      const [, params] = repo.manager.query.mock.calls[0];
      expect(params[4]).toBe(JSON.stringify({ txHash: 'th_1' }));
    });

    it('returns the inserted record and the unread count from the same row', async () => {
      repo.manager.query.mockResolvedValue([
        rowFixture({ id: 12, unread_count: 3 }),
      ]);

      const out = await service.recordAndCountUnread(
        'ak_owner',
        'post-comment',
        {
          title: 't',
          body: 'b',
        },
      );

      expect(out.record).toMatchObject({ id: 12, address: 'ak_owner' });
      expect(out.unreadCount).toBe(3);
    });
  });

  it('returns a nextCursor when the page is full', async () => {
    const items = [{ id: 9 }, { id: 7 }, { id: 5 }];
    const qb = makeQb({ getMany: items });
    repo.createQueryBuilder.mockReturnValue(qb);

    const page = await service.listFor('ak_owner', { limit: 3 });
    expect(page.items).toBe(items);
    expect(page.nextCursor).toBe(5); // last id of a full page
    expect(qb.andWhere).not.toHaveBeenCalled(); // no cursor passed
  });

  it('scopes the list to the address and orders newest-id first', async () => {
    const qb = makeQb({ getMany: [] });
    repo.createQueryBuilder.mockReturnValue(qb);

    await service.listFor('ak_owner', { limit: 3 });
    // The cross-account isolation predicate and the keyset ordering are the two
    // things a regression here would silently break, so assert them explicitly.
    expect(qb.where).toHaveBeenCalledWith('n.address = :address', {
      address: 'ak_owner',
    });
    expect(qb.orderBy).toHaveBeenCalledWith('n.id', 'DESC');
    expect(qb.take).toHaveBeenCalledWith(3);
  });

  it('returns nextCursor=null on a partial (final) page and applies the cursor', async () => {
    const qb = makeQb({ getMany: [{ id: 4 }] });
    repo.createQueryBuilder.mockReturnValue(qb);

    const page = await service.listFor('ak_owner', { cursor: 5, limit: 3 });
    expect(page.nextCursor).toBeNull();
    expect(qb.andWhere).toHaveBeenCalledWith('n.id < :cursor', { cursor: 5 });
  });

  it('counts unread rows', async () => {
    repo.count.mockResolvedValue(2);
    await expect(service.unreadCount('ak_owner')).resolves.toBe(2);
  });

  describe('markRead', () => {
    it('short-circuits markRead([]) to just the current unread count', async () => {
      repo.count.mockResolvedValue(3);
      await expect(service.markRead('ak_owner', [])).resolves.toBe(3);
      expect(repo.manager.query).not.toHaveBeenCalled();
    });

    it('fuses the UPDATE and the recount into ONE round-trip (no separate query)', async () => {
      // Same rationale as recordAndCountUnread: a separate write then a
      // separately-awaited read leaves a gap a concurrent insert's own
      // write+emit can land in, so a stale count read here could overwrite a
      // fresher one emitted by that concurrent insert. Fusing removes the gap.
      repo.manager.query.mockResolvedValue([{ unread_count: 0 }]);

      await service.markRead('ak_owner', [5, 6]);

      expect(repo.manager.query).toHaveBeenCalledTimes(1);
    });

    it('scopes the update to the address, unread rows, and the given ids', async () => {
      repo.manager.query.mockResolvedValue([{ unread_count: 0 }]);

      await service.markRead('ak_owner', [5, 6]);

      const [sql, params] = repo.manager.query.mock.calls[0];
      expect(sql).toMatch(/UPDATE notifications/i);
      expect(sql).toMatch(/WHERE address = \$1 AND read_at IS NULL/i);
      expect(sql).toMatch(/id = ANY\(\$2::int\[\]\)/i);
      expect(sql).toMatch(/RETURNING id/i);
      expect(params).toEqual(['ak_owner', [5, 6]]);
    });

    it('mark-all (no ids) skips the id filter and passes only the address', async () => {
      repo.manager.query.mockResolvedValue([{ unread_count: 1 }]);

      await expect(service.markRead('ak_owner')).resolves.toBe(1);

      const [sql, params] = repo.manager.query.mock.calls[0];
      expect(sql).not.toMatch(/id = ANY/i);
      expect(params).toEqual(['ak_owner']);
    });

    it('returns the unread_count computed by the fused statement', async () => {
      repo.manager.query.mockResolvedValue([{ unread_count: 7 }]);
      await expect(service.markRead('ak_owner', [5])).resolves.toBe(7);
    });

    it("subtracts the RETURNING row count (opposite correction from recordAndCountUnread's +1)", async () => {
      // Regression guard for the CTE-snapshot quirk in the OTHER direction: the
      // outer count subquery re-reads `notifications` against the pre-statement
      // snapshot, so it still counts the just-updated rows as unread. Adding 1
      // here (recordAndCountUnread's correction) would be wrong; subtracting the
      // RETURNING row count is what makes this exact, not approximate.
      repo.manager.query.mockResolvedValue([{ unread_count: 0 }]);
      await service.markRead('ak_owner', [5, 6]);
      const [sql] = repo.manager.query.mock.calls[0];
      expect(sql).toMatch(/-\s*\(SELECT count\(\*\)::int FROM updated\)/i);
    });
  });

  describe('prune', () => {
    it('deletes aged read rows, bounded to the batch size, then trims over-cap addresses to the newest N', async () => {
      const manager = {
        query: jest.fn().mockResolvedValue(undefined),
      } as any;

      await service.prune(manager, 90, 500, 10_000);

      expect(manager.query).toHaveBeenCalledTimes(2);

      // #1 retention delete: read rows older than the 90-day cutoff, bounded
      // to at most `retentionDeleteBatchSize` rows so a large backlog (a long
      // cron outage, or a shortened NOTIF_FEED_RETENTION_DAYS) can't turn into
      // one unbounded DELETE holding row locks for however many rows aged out.
      const [retentionSql, retentionParams] = manager.query.mock.calls[0];
      expect(retentionSql).toMatch(/DELETE FROM notifications/i);
      expect(retentionSql).toMatch(/read_at IS NOT NULL/i);
      expect(retentionSql).toMatch(/created_at < \$1/i);
      expect(retentionSql).toMatch(/LIMIT \$2/i);
      expect(retentionParams[0]).toBeInstanceOf(Date);
      expect(retentionParams[1]).toBe(10_000);

      // #2 per-address cap: window-function delete bound to $1 = maxRowsPerAddress,
      // and pre-filtered to addresses that actually exceed the cap (so it does
      // not rank the whole table).
      const [capSql, capParams] = manager.query.mock.calls[1];
      expect(capParams).toEqual([500]);
      expect(capSql).toMatch(/HAVING count\(\*\) > \$1/i);
      expect(capSql).toMatch(/row_number\(\) OVER/i);
      expect(capSql).toMatch(/ranked\.rn > \$1/i);
    });

    it('computes the cutoff as retentionDays before now', async () => {
      const manager = { query: jest.fn().mockResolvedValue(undefined) } as any;
      const before = Date.now();

      await service.prune(manager, 7, 500, 10_000);

      const after = Date.now();
      const [, params] = manager.query.mock.calls[0];
      const cutoff: Date = params[0];
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - sevenDaysMs);
      expect(cutoff.getTime()).toBeLessThanOrEqual(after - sevenDaysMs);
    });
  });
});

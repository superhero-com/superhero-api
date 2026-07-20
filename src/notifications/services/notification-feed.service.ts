import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';
import { DatabaseNotificationContent } from '../core/notification.interface';
import { NotificationRecord } from '../entities/notification.entity';

export interface FeedPage {
  items: NotificationRecord[];
  /** Pass back as `cursor` to fetch the next (older) page; null when exhausted. */
  nextCursor: number | null;
}

/**
 * Read/write model for the per-recipient web feed. The feed is the source of
 * truth: the websocket emit is best-effort, so clients reconcile by listing the
 * feed on (re)connect. All queries are scoped by `address` — the controller's
 * session guard proves the caller owns that address before any of these run.
 */
@Injectable()
export class NotificationFeedService {
  constructor(
    @InjectRepository(NotificationRecord)
    private readonly repo: Repository<NotificationRecord>,
  ) {}

  /**
   * Persist one notification AND return the address's resulting unread count,
   * in a SINGLE statement/round-trip. This is the ONLY insert path for the feed
   * — deliberately so, and it must stay that way.
   *
   * Do NOT add a bare `record()`/insert-only method alongside it. The obvious
   * shape a caller reaches for — insert, then separately `await unreadCount()`
   * — has an `await` gap between the write and the read; during that gap a
   * CONCURRENT `markRead()` can complete its own write AND emit (correctly
   * showing, say, 0 unread), and then the separately-read count — computed from
   * a snapshot taken BEFORE markRead's write — resolves and gets emitted AFTER,
   * overwriting the correct badge with a stale, higher value. Open tabs then
   * show a wrong badge until the next reconnect refresh. Fusing the count into
   * the INSERT's own statement via a CTE means the subquery runs in the SAME
   * database round-trip as the insert: it necessarily observes whatever had
   * ALREADY committed — no separate `await`, so no window for an unrelated
   * request's entire write-then-emit sequence to interleave in between. An
   * insert-only method existing at all is what invites that race back in.
   *
   * One subtlety: Postgres runs every statement inside a `WITH` — including the
   * main query — against ONE shared snapshot, and a data-modifying CTE's
   * effects on its target table are visible to the rest of the query ONLY via
   * its `RETURNING` list (see the "Data-Modifying Statements in WITH" section
   * of the Postgres docs). So the count subquery below, which re-queries
   * `notifications` directly, can NOT see the row `ins` just inserted — left
   * alone it would undercount the true badge by exactly one. The `+ 1` accounts
   * for that row explicitly: it's unconditionally unread (`read_at` is NULL by
   * construction, same statement) and nothing else can reference it before this
   * statement commits, so adding 1 is exact, not an approximation.
   */
  async recordAndCountUnread(
    address: string,
    type: string,
    content: DatabaseNotificationContent,
  ): Promise<{ record: NotificationRecord; unreadCount: number }> {
    const dataParam =
      content.data !== undefined && content.data !== null
        ? JSON.stringify(content.data)
        : null;
    const rows = await this.repo.manager.query(
      `WITH ins AS (
         INSERT INTO notifications (address, type, title, body, data, read_at)
         VALUES ($1, $2, $3, $4, $5, NULL)
         RETURNING id, address, type, title, body, data, read_at, created_at
       )
       SELECT ins.*,
         (SELECT count(*)::int FROM notifications
           WHERE address = $1 AND read_at IS NULL) + 1 AS unread_count
       FROM ins`,
      [address, type, content.title, content.body, dataParam],
    );
    const row = rows[0];
    const record: NotificationRecord = {
      id: row.id,
      address: row.address,
      type: row.type,
      title: row.title,
      body: row.body,
      data: row.data,
      read_at: row.read_at,
      created_at: row.created_at,
    } as NotificationRecord;
    return { record, unreadCount: row.unread_count };
  }

  /**
   * Newest-first page. Cursor is the id of the last item from the previous page;
   * we return rows with a strictly smaller id (stable because id is monotonic).
   */
  async listFor(
    address: string,
    opts: { cursor?: number; limit: number },
  ): Promise<FeedPage> {
    const qb = this.repo
      .createQueryBuilder('n')
      .where('n.address = :address', { address })
      .orderBy('n.id', 'DESC')
      .take(opts.limit);
    if (opts.cursor !== undefined) {
      qb.andWhere('n.id < :cursor', { cursor: opts.cursor });
    }
    const items = await qb.getMany();
    const nextCursor =
      items.length === opts.limit ? items[items.length - 1].id : null;
    return { items, nextCursor };
  }

  async unreadCount(address: string): Promise<number> {
    return this.repo.count({ where: { address, read_at: IsNull() } });
  }

  /**
   * Mark the given ids read (scoped to `address` so a caller can't flip another
   * account's rows), or all unread rows when `ids` is omitted. Returns the
   * resulting unread count so the caller can push the new badge value.
   *
   * UPDATE and the recount are fused into ONE statement/round-trip — the same
   * shape (and for the same reason) as `recordAndCountUnread`. A separate
   * `await unreadCount()` after the UPDATE has a gap during which a concurrent
   * `recordAndCountUnread` can commit its own insert+count+emit; if that
   * emit's count then loses the race to arrive before this method's, the
   * correct, fresher count gets overwritten by this method's now-stale one.
   * Fusing removes the gap: nothing can interleave between the write and the
   * read within a single statement.
   *
   * Unlike `recordAndCountUnread` (which needs a `+ 1` to account for a
   * just-inserted row a data-modifying CTE can't see except via `RETURNING`),
   * this needs the opposite correction: the outer count subquery re-reads
   * `notifications` against the SAME pre-statement snapshot, so it still
   * counts the rows this statement just marked read as unread. Subtracting
   * `RETURNING`'s row count (rows actually flipped) yields the true
   * post-update count without a second query.
   */
  async markRead(address: string, ids?: number[]): Promise<number> {
    if (ids && ids.length === 0) {
      return this.unreadCount(address);
    }
    const idFilter = ids ? 'AND id = ANY($2::int[])' : '';
    const params: unknown[] = ids ? [address, ids] : [address];
    const rows = await this.repo.manager.query(
      `WITH updated AS (
         UPDATE notifications
         SET read_at = CURRENT_TIMESTAMP(6)
         WHERE address = $1 AND read_at IS NULL ${idFilter}
         RETURNING id
       )
       SELECT
         (SELECT count(*)::int FROM notifications
           WHERE address = $1 AND read_at IS NULL)
         - (SELECT count(*)::int FROM updated) AS unread_count`,
      params,
    );
    return rows[0].unread_count;
  }

  /**
   * Retention sweep. Deletes read rows older than `retentionDays` (at most
   * `retentionDeleteBatchSize` per call — see FeedRetentionService, which
   * calls this once per hourly tick, so a backlog larger than the batch is
   * finished off over subsequent ticks instead of one unbounded DELETE), then
   * trims each address back to its newest `maxRowsPerAddress` rows. Takes the
   * `EntityManager` so the caller can run it inside the advisory-lock
   * transaction (see FeedRetentionService) — both statements then share the
   * locked connection and only one replica acts per tick.
   */
  async prune(
    manager: EntityManager,
    retentionDays: number,
    maxRowsPerAddress: number,
    retentionDeleteBatchSize: number,
  ): Promise<void> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    await manager.query(
      `DELETE FROM notifications
       WHERE id IN (
         SELECT id FROM notifications
         WHERE read_at IS NOT NULL AND created_at < $1
         LIMIT $2
       )`,
      [cutoff, retentionDeleteBatchSize],
    );

    // Per-address cap: drop everything beyond the newest N rows for each address.
    // The window function only runs over addresses that can actually exceed the
    // cap (a cheap grouped count, index-only on (address, id)); without that
    // pre-filter Postgres would rank EVERY row in the table on every tick — a
    // full scan + large sort that grows with the table and almost always deletes
    // nothing. id is monotonic with insert order, so ordering by id alone is the
    // newest-first order (no created_at tiebreak needed).
    await manager.query(
      `DELETE FROM notifications
       WHERE id IN (
         SELECT id FROM (
           SELECT id, row_number() OVER (
             PARTITION BY address ORDER BY id DESC
           ) AS rn
           FROM notifications
           WHERE address IN (
             SELECT address FROM notifications
             GROUP BY address HAVING count(*) > $1
           )
         ) ranked
         WHERE ranked.rn > $1
       )`,
      [maxRowsPerAddress],
    );
  }
}

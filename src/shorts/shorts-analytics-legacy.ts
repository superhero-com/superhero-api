import { createHash } from 'node:crypto';
import { ShortsStoreService } from './shorts-store.service';
import { legacyHasTable } from './shorts-legacy-snapshot';

type Kind = 'plays' | 'totals' | 'forgotten';
export interface LegacyAnalytics {
  salt: string;
  since: number;
  fingerprint: string;
  pages(kind: Kind): Generator<Record<string, string | number>[]>;
}

/** Bounded reads while the source SQLite ownership lock is held. Never mutate it. */
export function legacyAnalytics(
  store: ShortsStoreService,
): LegacyAnalytics | undefined {
  const exists = (name: string) => legacyHasTable(store, name);
  if (!exists('shorts_analytics_settings')) {
    if (
      ['shorts_plays', 'shorts_view_totals', 'shorts_forgotten_viewers'].some(
        exists,
      )
    )
      throw new Error('Legacy analytics have no matching privacy salt');
    return;
  }
  const settings = store.db
    .prepare('SELECT salt,since FROM shorts_analytics_settings ORDER BY id')
    .all();
  if (settings.length !== 1 || !exists('shorts_plays'))
    throw new Error('Incomplete legacy analytics');
  const salt = String(settings[0].salt),
    since = Number(settings[0].since);
  if (!/^[a-f0-9]{64}$/.test(salt) || !Number.isSafeInteger(since) || since < 0)
    throw new Error('Invalid legacy analytics settings');
  function* pages(kind: Kind) {
    let after = '';
    while (true) {
      let rows: Record<string, string | number>[];
      if (kind === 'plays')
        rows = store.db
          .prepare(
            `SELECT id,short_id,viewer,started,seconds,source,duration
        FROM shorts_plays WHERE id>? ORDER BY id LIMIT 500`,
          )
          .all(after);
      else if (kind === 'totals')
        rows = exists('shorts_view_totals')
          ? store.db
              .prepare(
                'SELECT short_id AS id,views FROM shorts_view_totals WHERE short_id>? ORDER BY short_id LIMIT 500',
              )
              .all(after)
          : store.db
              .prepare(
                'SELECT short_id AS id,count(*) AS views FROM shorts_plays WHERE seconds>=2 AND short_id>? GROUP BY short_id ORDER BY short_id LIMIT 500',
              )
              .all(after);
      else
        rows = exists('shorts_forgotten_viewers')
          ? store.db
              .prepare(
                'SELECT viewer AS id,expires FROM shorts_forgotten_viewers WHERE viewer>? ORDER BY viewer LIMIT 500',
              )
              .all(after)
          : [];
      if (!rows.length) return;
      yield rows;
      after = String(rows.at(-1)!.id);
    }
  }
  const hash = createHash('sha256').update(JSON.stringify([salt, since]));
  for (const kind of ['plays', 'totals', 'forgotten'] as const) {
    hash.update(kind);
    for (const rows of pages(kind))
      for (const row of rows) hash.update(JSON.stringify(row));
  }
  return { salt, since, fingerprint: hash.digest('hex'), pages };
}

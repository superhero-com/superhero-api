import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { ShortsStoreService } from './shorts-store.service';

export const ANALYTICS_DAY = 86400000;
export interface PlaybackEvent {
  id: string;
  session: string;
  seconds: number;
  source: string;
}
interface Play {
  id: string;
  short_id: string;
  viewer: string;
  started: number;
  seconds: number;
  source: string;
  duration: number;
}
export function playbackSummary(plays: Play[]) {
  const qualified = plays.filter((p) => p.seconds >= 2);
  const watchSeconds = qualified.reduce((n, p) => n + p.seconds, 0);
  return {
    views: qualified.length,
    reach: new Set(qualified.map((p) => p.viewer)).size,
    watchSeconds,
    watchHours: watchSeconds / 3600,
    averageSeconds: qualified.length ? watchSeconds / qualified.length : null,
    completion: qualified.length
      ? qualified.filter((p) => p.seconds >= p.duration * 0.95).length /
        qualified.length
      : null,
    retention: [25, 50, 75, 95].map((at) => ({
      at,
      viewers: qualified.filter((p) => p.seconds >= (p.duration * at) / 100)
        .length,
    })),
  };
}
@Injectable()
export class ShortsAnalyticsService {
  readonly since: number;
  private salt: string;
  constructor(private readonly store: ShortsStoreService) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS shorts_analytics_settings (id INTEGER PRIMARY KEY, salt TEXT NOT NULL, since INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS shorts_plays (id TEXT PRIMARY KEY, short_id TEXT NOT NULL, viewer TEXT NOT NULL, started INTEGER NOT NULL, seconds REAL NOT NULL, source TEXT NOT NULL, duration REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS shorts_plays_period ON shorts_plays(started,short_id);`);
    // Anonymous lifetime totals survive expiry of the browser-level measurements.
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS shorts_view_totals (short_id TEXT PRIMARY KEY, views INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS shorts_forgotten_viewers (viewer TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS shorts_plays_viewer ON shorts_plays(viewer,short_id,started);
      INSERT OR IGNORE INTO shorts_view_totals SELECT short_id, COUNT(*) FROM shorts_plays WHERE seconds>=2 GROUP BY short_id;`);
    store.db
      .prepare('INSERT OR IGNORE INTO shorts_analytics_settings VALUES(1,?,?)')
      .run(randomBytes(32).toString('hex'), Date.now());
    const settings = store.db
      .prepare('SELECT * FROM shorts_analytics_settings WHERE id=1')
      .get()!;
    this.salt = String(settings.salt);
    this.since = Number(settings.since);
  }
  private viewer(session: string) {
    if (typeof session !== 'string' || !/^[a-zA-Z0-9-]{20,80}$/.test(session))
      throw new Error('Invalid viewer session');
    return createHash('sha256').update(`${this.salt}:${session}`).digest('hex');
  }
  private prune(now: number) {
    this.store.db
      .prepare('DELETE FROM shorts_plays WHERE started<?')
      .run(now - 90 * ANALYTICS_DAY);
    this.store.db
      .prepare('DELETE FROM shorts_forgotten_viewers WHERE expires<?')
      .run(now);
  }
  engagement(shortId: string, now = Date.now()) {
    this.prune(now);
    const rows = this.store.db
      .prepare(
        'SELECT * FROM shorts_plays WHERE short_id=? AND started>=? AND seconds>=2',
      )
      .all(shortId, now - 7 * ANALYTICS_DAY) as unknown as Play[];
    // Average within each browser first so daily return visits cannot dominate quality.
    const browsers = new Map<string, number[]>();
    rows.forEach((p) => {
      const quality =
        0.7 * Math.min(1, p.seconds / p.duration) +
        0.3 * Number(p.seconds >= p.duration * 0.95);
      browsers.set(p.viewer, [...(browsers.get(p.viewer) || []), quality]);
    });
    const quality = [...browsers.values()].reduce(
      (sum, values) => sum + values.reduce((a, b) => a + b, 0) / values.length,
      0,
    );
    // Twenty neutral prior browsers keep small samples from overwhelming discovery.
    return {
      score: browsers.size < 5 ? 0.5 : (quality + 10) / (browsers.size + 20),
    };
  }
  counters(shortId: string) {
    return {
      views: Number(
        this.store.db
          .prepare('SELECT views FROM shorts_view_totals WHERE short_id=?')
          .get(shortId)?.views || 0,
      ),
      engagement: this.engagement(shortId),
    };
  }
  record(short: { id: string; duration: number }, event: PlaybackEvent) {
    if (
      !event ||
      typeof event.id !== 'string' ||
      !/^[a-zA-Z0-9-]{20,80}$/.test(event.id) ||
      !Number.isFinite(event.seconds) ||
      event.seconds < 0 ||
      event.seconds > 65 ||
      !['for-you', 'following', 'recent', 'saved', 'shared'].includes(
        event.source,
      )
    )
      throw new Error('Invalid playback event');
    const viewer = this.viewer(event.session),
      now = Date.now();
    this.prune(now);
    if (
      this.store.db
        .prepare('SELECT viewer FROM shorts_forgotten_viewers WHERE viewer=?')
        .get(viewer)
    )
      return { accepted: false, ...this.counters(short.id) };
    const existing = this.store.db
      .prepare('SELECT * FROM shorts_plays WHERE id=?')
      .get(event.id);
    if (
      existing &&
      (existing.viewer !== viewer || existing.short_id !== short.id)
    )
      throw new Error('Playback session mismatch');
    const dayStart = Math.floor(now / ANALYTICS_DAY) * ANALYTICS_DAY;
    if (existing && Number(existing.started) < dayStart)
      return { accepted: false, ...this.counters(short.id) };
    if (!existing) {
      const count = this.store.db
        .prepare(
          'SELECT COUNT(*) AS n FROM shorts_plays WHERE viewer=? AND started>?',
        )
        .get(viewer, now - ANALYTICS_DAY);
      if (Number(count?.n) >= 1000) throw new Error('Playback limit reached');
      // One qualified play per browser/Short/day; repeated loops cannot inflate views.
      const prior = this.store.db
        .prepare(
          'SELECT id FROM shorts_plays WHERE viewer=? AND short_id=? AND started>=?',
        )
        .get(viewer, short.id, dayStart);
      if (prior) return { accepted: false, ...this.counters(short.id) };
      this.store.db
        .prepare('INSERT INTO shorts_plays VALUES(?,?,?,?,?,?,?)')
        .run(event.id, short.id, viewer, now, 0, event.source, short.duration);
    }
    const started = Number(existing?.started ?? now);
    const seconds = Math.min(
      short.duration,
      event.seconds,
      Math.max(0, (now - started) / 1000 + 0.5),
    );
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db
        .prepare('UPDATE shorts_plays SET seconds=MAX(seconds,?) WHERE id=?')
        .run(seconds, event.id);
      if (Number(existing?.seconds || 0) < 2 && seconds >= 2)
        this.store.db
          .prepare(
            'INSERT INTO shorts_view_totals VALUES(?,1) ON CONFLICT(short_id) DO UPDATE SET views=views+1',
          )
          .run(short.id);
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
    return { accepted: true, ...this.counters(short.id) };
  }
  forget(session: string) {
    const viewer = this.viewer(session);
    this.prune(Date.now());
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db
        .prepare(
          `UPDATE shorts_view_totals SET views=MAX(0, views-(SELECT COUNT(*) FROM shorts_plays WHERE viewer=? AND short_id=shorts_view_totals.short_id AND seconds>=2))`,
        )
        .run(viewer);
      this.store.db
        .prepare('DELETE FROM shorts_plays WHERE viewer=?')
        .run(viewer);
      // A short-lived salted revocation prevents already-in-flight requests recreating deleted data.
      this.store.db
        .prepare('INSERT OR REPLACE INTO shorts_forgotten_viewers VALUES(?,?)')
        .run(viewer, Date.now() + ANALYTICS_DAY);
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
    return { deleted: true };
  }
  report(shortIds: string[], days: number, now = Date.now()) {
    const end = Math.floor(now / ANALYTICS_DAY) * ANALYTICS_DAY + ANALYTICS_DAY;
    const start = end - days * ANALYTICS_DAY;
    const oldest = Math.max(this.since, now - 90 * ANALYTICS_DAY);
    this.prune(now);
    const ids = new Set(shortIds);
    const plays = this.store.db
      .prepare('SELECT * FROM shorts_plays WHERE started>=? AND started<?')
      .all(start - days * ANALYTICS_DAY, end)
      .filter((p) => ids.has(String(p.short_id))) as unknown as Play[];
    const current = plays.filter((p) => p.started >= start);
    const previous = plays.filter((p) => p.started < start);
    return {
      days,
      start,
      end,
      timezone: 'UTC',
      since: this.since,
      retentionDays: 90,
      partial: oldest > start,
      previousPartial: oldest > start - days * ANALYTICS_DAY,
      summary: playbackSummary(current),
      previous: playbackSummary(previous),
      series: Array.from({ length: days }, (_, i) => {
        const at = start + i * ANALYTICS_DAY;
        return {
          at,
          ...playbackSummary(
            current.filter(
              (p) => p.started >= at && p.started < at + ANALYTICS_DAY,
            ),
          ),
        };
      }),
      videos: Object.fromEntries(
        shortIds.map((id) => [
          id,
          playbackSummary(current.filter((p) => p.short_id === id)),
        ]),
      ),
      sources: ['for-you', 'following', 'recent', 'saved', 'shared'].map(
        (source) => {
          const rows = current.filter(
            (p) => p.source === source && p.seconds >= 2,
          );
          const viewers = new Set(rows.map((p) => p.viewer)).size;
          return {
            source,
            views: viewers >= 5 ? rows.length : null,
            suppressed: viewers < 5,
          };
        },
      ),
    };
  }
}

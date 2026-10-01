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
    this.store.db
      .prepare('DELETE FROM shorts_plays WHERE started<?')
      .run(now - 90 * ANALYTICS_DAY);
    const existing = this.store.db
      .prepare('SELECT * FROM shorts_plays WHERE id=?')
      .get(event.id);
    if (
      existing &&
      (existing.viewer !== viewer || existing.short_id !== short.id)
    )
      throw new Error('Playback session mismatch');
    if (!existing) {
      const count = this.store.db
        .prepare(
          'SELECT COUNT(*) AS n FROM shorts_plays WHERE viewer=? AND started>?',
        )
        .get(viewer, now - ANALYTICS_DAY);
      if (Number(count?.n) >= 1000) throw new Error('Playback limit reached');
      // One qualified play per browser/Short/day; repeated loops cannot inflate views.
      const dayStart = Math.floor(now / ANALYTICS_DAY) * ANALYTICS_DAY;
      const prior = this.store.db
        .prepare(
          'SELECT id FROM shorts_plays WHERE viewer=? AND short_id=? AND started>=?',
        )
        .get(viewer, short.id, dayStart);
      if (prior) return { accepted: false };
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
    this.store.db
      .prepare('UPDATE shorts_plays SET seconds=MAX(seconds,?) WHERE id=?')
      .run(seconds, event.id);
    return { accepted: true };
  }
  forget(session: string) {
    this.store.db
      .prepare('DELETE FROM shorts_plays WHERE viewer=?')
      .run(this.viewer(session));
    return { deleted: true };
  }
  report(shortIds: string[], days: number, now = Date.now()) {
    const end = Math.floor(now / ANALYTICS_DAY) * ANALYTICS_DAY + ANALYTICS_DAY;
    const start = end - days * ANALYTICS_DAY;
    const oldest = Math.max(this.since, now - 90 * ANALYTICS_DAY);
    this.store.db
      .prepare('DELETE FROM shorts_plays WHERE started<?')
      .run(now - 90 * ANALYTICS_DAY);
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

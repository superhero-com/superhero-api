import { ShortsDatabaseService } from './shorts-database.service';
import {
  Inject,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { ShortsScope } from './shorts-metadata.service';
import {
  ANALYTICS_DAY,
  AnalyticsReport,
  PlaybackEvent,
  PlaybackSummary,
  playbackStart,
} from './shorts-analytics.service';
import { LegacyAnalytics } from './shorts-analytics-legacy';

const SOURCES = ['for-you', 'following', 'recent', 'saved', 'shared'];
const clock = 'floor(extract(epoch FROM clock_timestamp())*1000)::bigint';
const digest = /^[a-f0-9]{64}$/;
const sessionId = /^[a-zA-Z0-9-]{20,80}$/;

@Injectable()
export class ShortsMeasurementsService {
  constructor(@Inject(ShortsDatabaseService) private readonly db: DataSource) {}
  private transaction<T>(
    work: (db: EntityManager) => Promise<T>,
    isolation: 'READ COMMITTED' | 'REPEATABLE READ' = 'READ COMMITTED',
  ) {
    return this.db.transaction(isolation, async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'",
      );
      return work(db);
    });
  }
  private scope(scope: ShortsScope) {
    if (
      !['ae_uat', 'ae_mainnet'].includes(scope?.network) ||
      !/^ct_[a-zA-Z0-9]{1,97}$/.test(scope.contract)
    )
      throw new BadRequestException('Invalid Shorts deployment scope');
    return [scope.network, scope.contract];
  }
  private id(id: unknown) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id))
      throw new BadRequestException('Invalid Short ID');
    return id;
  }
  private async now(db: DataSource | EntityManager) {
    return Number((await db.query(`SELECT ${clock} AS now`))[0].now);
  }
  private async settings(db: DataSource | EntityManager, params: string[]) {
    const [settings] = await db.query(
      'SELECT salt,since FROM shorts_measurement_settings WHERE network=$1 AND contract=$2',
      params,
    );
    if (!settings)
      throw new ServiceUnavailableException('Analytics are not initialized');
    return settings;
  }
  private viewer(salt: string, session: string) {
    if (typeof session !== 'string' || !sessionId.test(session))
      throw new BadRequestException('Invalid viewer session');
    return createHash('sha256').update(`${salt}:${session}`).digest('hex');
  }
  async initialize(
    scope: ShortsScope,
    sourceHash: string,
    legacy?: LegacyAnalytics,
    allowImport = false,
  ) {
    const params = this.scope(scope);
    return this.transaction(async (db) => {
      const [runtime] = await db.query(
        'SELECT source_hash FROM shorts_runtime WHERE network=$1 AND contract=$2 FOR UPDATE',
        params,
      );
      if (!runtime || runtime.source_hash !== sourceHash)
        throw new ServiceUnavailableException(
          'Analytics deployment does not match',
        );
      const [existing] = await db.query(
        'SELECT since,legacy_hash FROM shorts_measurement_settings WHERE network=$1 AND contract=$2 FOR UPDATE',
        params,
      );
      if (existing) {
        if (legacy && existing.legacy_hash !== legacy.fingerprint)
          throw new ConflictException(
            'Legacy analytics need an empty destination and matching migration',
          );
        return Number(existing.since);
      }
      if (legacy && !allowImport)
        throw new ConflictException(
          'Legacy analytics require explicit migration',
        );
      const now = await this.now(db),
        since = legacy?.since ?? now;
      await db.query(
        'INSERT INTO shorts_measurement_settings(network,contract,salt,since) VALUES($1,$2,$3,$4)',
        [...params, legacy?.salt ?? randomBytes(32).toString('hex'), since],
      );
      if (legacy) {
        await this.importLegacy(db, params, legacy, now);
        await db.query(
          'UPDATE shorts_measurement_settings SET legacy_hash=$3 WHERE network=$1 AND contract=$2',
          [...params, legacy.fingerprint],
        );
      }
      return since;
    });
  }
  private async importLegacy(
    db: EntityManager,
    params: string[],
    legacy: LegacyAnalytics,
    now: number,
  ) {
    for (const rows of legacy.pages('forgotten'))
      for (const r of rows) {
        if (
          !digest.test(String(r.id)) ||
          !Number.isSafeInteger(r.expires) ||
          Number(r.expires) < 0
        )
          throw new Error('Invalid legacy privacy marker');
        if (Number(r.expires) > now)
          await db.query(
            `INSERT INTO shorts_measurement_viewers(network,contract,viewer,touched,forgotten_until)
        VALUES($1,$2,$3,$4,$5)`,
            [...params, r.id, now, r.expires],
          );
      }
    for (const rows of legacy.pages('plays'))
      for (const r of rows) {
        this.id(r.short_id);
        if (
          !sessionId.test(String(r.id)) ||
          !digest.test(String(r.viewer)) ||
          !Number.isSafeInteger(r.started) ||
          Number(r.started) < 0 ||
          Number(r.started) > now ||
          !Number.isFinite(r.seconds) ||
          Number(r.seconds) < 0 ||
          Number(r.seconds) > Number(r.duration) ||
          !Number.isFinite(r.duration) ||
          Number(r.duration) < 2 ||
          Number(r.duration) > 60 ||
          !SOURCES.includes(String(r.source))
        )
          throw new Error('Invalid legacy playback');
        if (Number(r.started) < now - 90 * ANALYTICS_DAY) continue;
        await db.query(
          `INSERT INTO shorts_measurement_viewers(network,contract,viewer,touched) VALUES($1,$2,$3,$4)
        ON CONFLICT(network,contract,viewer) DO UPDATE SET touched=greatest(shorts_measurement_viewers.touched,excluded.touched)`,
          [...params, r.viewer, r.started],
        );
        const [blocked] = await db.query(
          'SELECT forgotten_until FROM shorts_measurement_viewers WHERE network=$1 AND contract=$2 AND viewer=$3',
          [...params, r.viewer],
        );
        if (Number(blocked.forgotten_until) > now)
          throw new Error('Deleted legacy playback cannot be reimported');
        await db.query(
          `INSERT INTO shorts_measurement_plays(network,contract,id,short_id,viewer,started,day,seconds,source,duration)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            ...params,
            r.id,
            r.short_id,
            r.viewer,
            r.started,
            Math.floor(Number(r.started) / ANALYTICS_DAY),
            r.seconds,
            r.source,
            r.duration,
          ],
        );
      }
    for (const rows of legacy.pages('totals'))
      for (const r of rows) {
        this.id(r.id);
        if (!Number.isSafeInteger(r.views) || Number(r.views) < 0)
          throw new Error('Invalid legacy view total');
        await db.query(
          'INSERT INTO shorts_measurement_totals VALUES($1,$2,$3,$4)',
          [...params, r.id, r.views],
        );
      }
    const [invalid] = await db.query(
      `SELECT 1 FROM shorts_measurement_plays p LEFT JOIN shorts_measurement_totals t
      ON t.network=p.network AND t.contract=p.contract AND t.short_id=p.short_id
      WHERE p.network=$1 AND p.contract=$2 AND p.seconds>=2 GROUP BY p.short_id,t.views
      HAVING count(*)>coalesce(t.views,0) LIMIT 1`,
      params,
    );
    if (invalid)
      throw new Error('Legacy lifetime totals do not cover retained playback');
  }
  private async lockViewer(
    db: EntityManager,
    params: string[],
    viewer: string,
  ) {
    // Upsert holds the same row lock for writes, deletion and retention cleanup.
    const [rows] = await db.query(
      `INSERT INTO shorts_measurement_viewers(network,contract,viewer,touched)
      VALUES($1,$2,$3,${clock}) ON CONFLICT(network,contract,viewer) DO UPDATE SET touched=excluded.touched
      RETURNING forgotten_until`,
      [...params, viewer],
    );
    return rows;
  }
  async record(
    scope: ShortsScope,
    shortId: string,
    event: PlaybackEvent,
    verifiedStart?: number,
  ) {
    this.id(shortId);
    if (
      !event ||
      typeof event.id !== 'string' ||
      !sessionId.test(event.id) ||
      !Number.isFinite(event.seconds) ||
      event.seconds < 0 ||
      event.seconds > 65 ||
      !SOURCES.includes(event.source)
    )
      throw new BadRequestException('Invalid playback event');
    const params = this.scope(scope);
    return this.transaction(async (db) => {
      const settings = await this.settings(db, params),
        viewer = this.viewer(settings.salt, event.session);
      if (verifiedStart !== undefined) {
        const observedAt = await this.now(db);
        if (
          Math.min(
            event.seconds,
            (observedAt - playbackStart(observedAt, verifiedStart)) / 1000 +
              0.5,
          ) < 2
        )
          return true;
      }
      const marker = await this.lockViewer(db, params, viewer);
      // A privacy lock may wait. Use the clock after admission for expiry and
      // the daily boundary, rather than the earlier no-write threshold check.
      const now = await this.now(db),
        initialStart = playbackStart(now, verifiedStart);
      if (Number(marker.forgotten_until) > now) return false;
      const [content] = await db.query(
        'SELECT body FROM shorts_content WHERE network=$1 AND contract=$2 AND id=$3',
        [...params, shortId],
      );
      const duration = Number(content?.body.duration);
      if (!Number.isFinite(duration) || duration < 2 || duration > 60)
        throw new BadRequestException('Unknown video duration');
      const day = Math.floor(now / ANALYTICS_DAY);
      let [play] = await db.query(
        'SELECT * FROM shorts_measurement_plays WHERE network=$1 AND contract=$2 AND id=$3 FOR UPDATE',
        [...params, event.id],
      );
      if (!play) {
        const [{ n }] = await db.query(
          'SELECT count(*)::integer AS n FROM shorts_measurement_plays WHERE network=$1 AND contract=$2 AND viewer=$3 AND started>$4',
          [...params, viewer, now - ANALYTICS_DAY],
        );
        if (n >= 1000) throw new BadRequestException('Playback limit reached');
        const rows = await db.query(
          `INSERT INTO shorts_measurement_plays(network,contract,id,short_id,viewer,started,day,seconds,source,duration)
          VALUES($1,$2,$3,$4,$5,$6,$7,0,$8,$9) ON CONFLICT DO NOTHING RETURNING *`,
          [
            ...params,
            event.id,
            shortId,
            viewer,
            initialStart,
            day,
            event.source,
            duration,
          ],
        );
        play = rows[0];
        if (!play) {
          [play] = await db.query(
            'SELECT * FROM shorts_measurement_plays WHERE network=$1 AND contract=$2 AND id=$3 FOR UPDATE',
            [...params, event.id],
          );
          if (!play) return false; // Another event already represents this browser/video/day.
        }
      }
      if (play.viewer !== viewer || play.short_id !== shortId)
        throw new BadRequestException('Playback session mismatch');
      if (Number(play.day) !== day) return false;
      const seconds = Math.max(
        play.seconds,
        Math.min(
          play.duration,
          event.seconds,
          Math.max(0, (now - Number(play.started)) / 1000 + 0.5),
        ),
      );
      await db.query(
        'UPDATE shorts_measurement_plays SET seconds=$4 WHERE network=$1 AND contract=$2 AND id=$3',
        [...params, event.id, seconds],
      );
      if (play.seconds < 2 && seconds >= 2)
        await db.query(
          `INSERT INTO shorts_measurement_totals VALUES($1,$2,$3,1)
        ON CONFLICT(network,contract,short_id) DO UPDATE SET views=shorts_measurement_totals.views+1`,
          [...params, shortId],
        );
      return true;
    });
  }
  async forget(scope: ShortsScope, session: string) {
    const params = this.scope(scope);
    return this.transaction(async (db) => {
      const settings = await this.settings(db, params),
        viewer = this.viewer(settings.salt, session);
      await this.lockViewer(db, params, viewer);
      const now = await this.now(db);
      const counts = await db.query(
        `SELECT short_id,count(*) AS n FROM shorts_measurement_plays
        WHERE network=$1 AND contract=$2 AND viewer=$3 AND started>=$4 AND seconds>=2 GROUP BY short_id ORDER BY short_id`,
        [...params, viewer, now - 90 * ANALYTICS_DAY],
      );
      for (const count of counts)
        await db.query(
          'UPDATE shorts_measurement_totals SET views=greatest(0,views-$4) WHERE network=$1 AND contract=$2 AND short_id=$3',
          [...params, count.short_id, count.n],
        );
      await db.query(
        'DELETE FROM shorts_measurement_plays WHERE network=$1 AND contract=$2 AND viewer=$3',
        [...params, viewer],
      );
      await db.query(
        'UPDATE shorts_measurement_viewers SET forgotten_until=$4 WHERE network=$1 AND contract=$2 AND viewer=$3',
        [...params, viewer, now + ANALYTICS_DAY],
      );
      return { deleted: true };
    });
  }
  async counters(scope: ShortsScope, id: string) {
    this.id(id);
    return this.transaction(async (db) => {
      const [row] = await db.query(
        `WITH quality AS (
      SELECT viewer,avg(0.7*least(1,seconds/duration)+0.3*(seconds>=duration*0.95)::integer) AS q
      FROM shorts_measurement_plays WHERE network=$1 AND contract=$2 AND short_id=$3
        AND started>=${clock}-604800000 AND seconds>=2 GROUP BY viewer
      ) SELECT coalesce((SELECT views FROM shorts_measurement_totals WHERE network=$1 AND contract=$2 AND short_id=$3),0) AS views,
        CASE WHEN count(*)<5 THEN 0.5 ELSE (sum(q)+10)/(count(*)+20) END AS score FROM quality`,
        [...this.scope(scope), id],
      );
      return {
        views: Number(row.views),
        engagement: { score: Number(row.score) },
      };
    });
  }
  private summary(row?: any): PlaybackSummary {
    const views = Number(row?.views ?? 0),
      watchSeconds = Number(row?.seconds ?? 0);
    return {
      views,
      reach: Number(row?.reach ?? 0),
      watchSeconds,
      watchHours: watchSeconds / 3600,
      averageSeconds: views ? watchSeconds / views : null,
      completion: views ? Number(row.complete) / views : null,
      retention: [25, 50, 75, 95].map((at) => ({
        at,
        viewers: Number(row?.[`r${at}`] ?? 0),
      })),
    };
  }
  async report(
    scope: ShortsScope,
    ids: string[],
    days: number,
  ): Promise<AnalyticsReport> {
    if (![7, 28, 90].includes(days) || !Array.isArray(ids) || ids.length > 100)
      throw new BadRequestException('Invalid analytics window');
    ids.forEach((id) => this.id(id));
    return this.reportSnapshot(scope, ids, days);
  }
  async creatorReport(
    scope: ShortsScope,
    creator: string,
    days: number,
    shortId?: string,
  ): Promise<AnalyticsReport> {
    if (
      typeof creator !== 'string' ||
      !/^ak_[a-zA-Z0-9]{1,97}$/.test(creator) ||
      ![7, 28, 90].includes(days)
    )
      throw new BadRequestException('Invalid creator analytics window');
    if (shortId !== undefined) this.id(shortId);
    return this.reportSnapshot(scope, null, days, creator, shortId);
  }
  private async reportSnapshot(
    scope: ShortsScope,
    ids: string[] | null,
    days: number,
    creator?: string,
    shortId?: string,
  ): Promise<AnalyticsReport> {
    return this.transaction(async (db) => {
      const params = this.scope(scope),
        settings = await this.settings(db, params),
        now = await this.now(db);
      const end =
          Math.floor(now / ANALYTICS_DAY) * ANALYTICS_DAY + ANALYTICS_DAY,
        start = end - days * ANALYTICS_DAY;
      const aggregate = `count(p.id) AS views,count(DISTINCT viewer) AS reach,sum(seconds) AS seconds,
      count(*) FILTER (WHERE seconds>=duration*0.95) AS complete,
      ${[25, 50, 75, 95].map((at) => `count(*) FILTER (WHERE seconds>=duration*${at}/100.0) AS r${at}`).join(',')}`;
      // Totals include the entire authenticated library. Only the per-video
      // breakdown is bounded; never load all video IDs or browser events in JS.
      const [result] = await db.query(
        `WITH owned AS MATERIALIZED (
          SELECT id,created_at FROM shorts_content
          WHERE network=$1 AND contract=$2
            AND (($8::text IS NULL AND id=ANY($3::text[]))
              OR ($8::text IS NOT NULL AND creator=$8 AND ($9::text IS NULL OR id=$9)))
        ), p AS MATERIALIZED (
          SELECT m.*,CASE WHEN started>=$4 THEN 'current' ELSE 'previous' END AS period
          FROM shorts_measurement_plays m JOIN owned o ON o.id=m.short_id
          WHERE network=$1 AND contract=$2
            AND started>=greatest($4-$5,$6) AND started<$7 AND seconds>=2
        ), videos AS (
          SELECT o.id AS key,${aggregate}
          FROM owned o LEFT JOIN p ON p.short_id=o.id AND p.period='current'
          GROUP BY o.id,o.created_at ORDER BY views DESC,o.created_at DESC,o.id DESC LIMIT 100
        ), stats AS (
          SELECT 'period' AS kind,period AS key,${aggregate} FROM p GROUP BY period
          UNION ALL SELECT 'day',(day*86400000)::text,${aggregate} FROM p WHERE period='current' GROUP BY day
          UNION ALL SELECT 'video',key,views,reach,seconds,complete,r25,r50,r75,r95 FROM videos
          UNION ALL SELECT 'source',source,${aggregate} FROM p WHERE period='current' GROUP BY source
        ) SELECT (SELECT count(*) FROM owned)::text AS video_count,
          coalesce((SELECT jsonb_agg(stats) FROM stats),'[]'::jsonb) AS stats`,
        [
          ...params,
          ids,
          start,
          days * ANALYTICS_DAY,
          now - 90 * ANALYTICS_DAY,
          end,
          creator ?? null,
          shortId ?? null,
        ],
      );
      if (creator && shortId !== undefined && !Number(result.video_count))
        throw new NotFoundException('Short not found');
      const rows: Record<string, any>[] = result.stats;
      const selected =
        ids ?? rows.filter((r) => r.kind === 'video').map((r) => String(r.key));
      const total = ids ? new Set(ids).size : Number(result.video_count);
      const byKey = new Map<string, Record<string, any>>(
        rows.map((r) => [`${r.kind}:${r.key}`, r]),
      );
      const since = Number(settings.since),
        oldest = Math.max(since, now - 90 * ANALYTICS_DAY);
      return {
        days,
        start,
        end,
        timezone: 'UTC',
        since,
        retentionDays: 90,
        partial: oldest > start,
        previousPartial: oldest > start - days * ANALYTICS_DAY,
        summary: this.summary(byKey.get('period:current')),
        previous: this.summary(byKey.get('period:previous')),
        series: Array.from({ length: days }, (_, i) => {
          const at = start + i * ANALYTICS_DAY;
          return { at, ...this.summary(byKey.get(`day:${at}`)) };
        }),
        videos: Object.fromEntries(
          selected.map((id) => [id, this.summary(byKey.get(`video:${id}`))]),
        ),
        videoBreakdown: {
          total,
          returned: new Set(selected).size,
          complete: total <= 100,
        },
        sources: SOURCES.map((source) => {
          const row = byKey.get(`source:${source}`),
            suppressed = Number(row?.reach ?? 0) < 5;
          return {
            source,
            views: suppressed ? null : Number(row.views),
            suppressed,
          };
        }),
      };
    }, 'REPEATABLE READ');
  }
  async prune(scope: ShortsScope) {
    return this.transaction(async (db) => {
      const params = this.scope(scope);
      const [, plays] = await db.query(
        `WITH expired AS (
      SELECT network,contract,id FROM shorts_measurement_plays WHERE network=$1 AND contract=$2
        AND started<${clock}-7776000000 ORDER BY started,id FOR UPDATE SKIP LOCKED LIMIT 5000
      ) DELETE FROM shorts_measurement_plays p USING expired e WHERE p.network=e.network AND p.contract=e.contract AND p.id=e.id`,
        params,
      );
      const [, viewers] = await db.query(
        `WITH expired AS (
      SELECT v.network,v.contract,v.viewer FROM shorts_measurement_viewers v WHERE v.network=$1 AND v.contract=$2
        AND v.touched<${clock}-86400000 AND v.forgotten_until<=${clock}
        AND NOT EXISTS(SELECT FROM shorts_measurement_plays p WHERE p.network=v.network AND p.contract=v.contract AND p.viewer=v.viewer)
        ORDER BY v.touched,v.viewer FOR UPDATE SKIP LOCKED LIMIT 5000
      ) DELETE FROM shorts_measurement_viewers v USING expired e WHERE v.network=e.network AND v.contract=e.contract AND v.viewer=e.viewer`,
        params,
      );
      return { plays, viewers };
    });
  }
}

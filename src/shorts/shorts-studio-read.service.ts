import { shortsRuntimeScope, shortsStorageScope } from './shorts-runtime-scope';
import { ShortsDatabaseService } from './shorts-database.service';
import {
  Inject,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ShortsChainService } from './shorts-chain.service';
import { ShortsIndexService } from './shorts-index.service';
import {
  STUDIO_PAGE_SIZE,
  studioCursor,
  studioQuery,
} from './shorts-studio-query';
import { ShortRecord } from './shorts.types';

export interface StudioRow {
  record: ShortRecord;
  publication: 'published' | 'draft' | 'withdrawn';
  likes: number;
  views: number;
  periodViews: number;
}
export interface StudioCounts {
  all: number;
  published: number;
  draft: number;
  withdrawn: number;
  restricted: number;
  firstRestricted?: string | null;
}

/** Creator read model over the existing plugin projection, never another chain listener. */
@Injectable()
export class ShortsStudioReadService {
  constructor(
    @Inject(ShortsDatabaseService) private readonly db: DataSource,
    private readonly chain: ShortsChainService,
    private readonly index: ShortsIndexService,
  ) {}
  async page(
    creator: string,
    input: Record<string, unknown>,
    selection?: { ids?: string[]; limit?: number },
  ) {
    const query = studioQuery(input);
    if (!/^ak_[a-zA-Z0-9]{1,97}$/.test(creator))
      throw new BadRequestException('Invalid creator');
    if (!this.chain.state.contract)
      throw new ServiceUnavailableException(
        'Shorts deployment is not initialized',
      );
    if (
      selection?.ids &&
      (selection.ids.length > STUDIO_PAGE_SIZE ||
        new Set(selection.ids).size !== selection.ids.length ||
        selection.ids.some(
          (id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id),
        ))
    )
      throw new BadRequestException('Invalid Short selection');
    const limit = selection?.limit ?? STUDIO_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > STUDIO_PAGE_SIZE)
      throw new BadRequestException('Invalid Studio page size');
    const v2 = this.chain.release.schemaVersion === 2;
    const media = shortsStorageScope(this.chain);
    const scope = [
      shortsRuntimeScope(this.chain).network,
      this.chain.state.contract,
      this.chain.state.sourceHash,
      creator,
    ];
    const cursor = studioCursor(scope, query),
      previous = cursor.direction === 'previous';
    const ascending = query.sort === 'oldest' || query.sort.endsWith('-asc');
    const order = ascending !== previous ? 'ASC' : 'DESC',
      compare = order === 'ASC' ? '>' : '<';
    const rank = query.sort.startsWith('likes')
      ? 'likes'
      : query.sort.startsWith('views')
        ? 'period_views'
        : 'created_at';
    await this.index.assertNetwork();
    return this.db.transaction('REPEATABLE READ', async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'",
      );
      const health = await this.index.health(db);
      const [{ now }] = await db.query(
        'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now',
      );
      const end = Math.floor(Number(now) / 86400000) * 86400000 + 86400000,
        start = end - query.days * 86400000;
      const [result] = await db.query(
        `WITH owned AS MATERIALIZED (
          SELECT id,creator,created_at,body->>'title' AS title,coalesce(body->>'reviewedTopic',body->>'topic') AS topic,
            body->>'publication' AS publication,body->>'moderation'='rejected' OR body->'safety'->>'status'='blocked' AS restricted
          FROM shorts_content WHERE network=$1 AND contract=$2 AND creator=$3 AND ($13::text[] IS NULL OR id=ANY($13))
        ), events AS (
          SELECT short_id,count(*) FILTER(WHERE action IN ('Liked','PaidLike')) AS likes,
            bool_or(action='Published') AS published,bool_or(action='Withdrawn') AS withdrawn
          FROM shorts_chain_events WHERE contract=$14 AND beneficiary=$3 AND block_height<=$4
            AND short_id IN (SELECT id FROM owned) GROUP BY short_id
        ), plays AS (
          SELECT short_id,count(*) AS views FROM shorts_measurement_plays
          WHERE network=$1 AND contract=$2 AND started>=$5 AND started<$6 AND seconds>=2
            AND short_id IN (SELECT id FROM owned) GROUP BY short_id
        ), library AS MATERIALIZED (
          SELECT o.*,CASE WHEN o.publication='withdrawn' OR e.withdrawn OR b.withdrawn THEN 'withdrawn'
            WHEN o.publication='published' AND (e.published OR b.id IS NOT NULL) THEN 'published' ELSE 'draft' END AS status,
            coalesce(e.likes,0)+coalesce(b.likes,0) AS likes,coalesce(p.views,0) AS period_views
          FROM owned o LEFT JOIN events e ON e.short_id=o.id LEFT JOIN plays p ON p.short_id=o.id
          ${v2 ? 'LEFT JOIN shorts_import_videos b ON b.network=$1 AND b.contract=$14 AND b.id=o.id' : 'LEFT JOIN (SELECT NULL::varchar AS id,0::bigint AS likes,false AS withdrawn) b ON false'}
        ), filtered AS MATERIALIZED (
          SELECT *,${rank} AS rank FROM library WHERE ($7='all' OR status=$7)
            AND ($8='' OR position(lower($8) in lower(coalesce(title,'')||' '||coalesce(topic,'')))>0)
        ), page AS (
          SELECT * FROM filtered WHERE ($9::bigint IS NULL OR (rank,created_at,id) ${compare} ($9,$10::bigint,$11::varchar))
          ORDER BY rank ${order},created_at ${order},id ${order} LIMIT $12
        ) SELECT
          (SELECT count(*) FROM filtered)::text AS total,
          (SELECT jsonb_build_object('all',count(*),'published',count(*) FILTER(WHERE status='published'),
            'draft',count(*) FILTER(WHERE status='draft'),'withdrawn',count(*) FILTER(WHERE status='withdrawn'),
            'restricted',count(*) FILTER(WHERE restricted AND status<>'withdrawn'),
            'firstRestricted',(SELECT id FROM library WHERE restricted AND status<>'withdrawn' ORDER BY created_at DESC,id DESC LIMIT 1)) FROM library) AS counts,
          coalesce((SELECT jsonb_agg(jsonb_build_object('record',c.body,'publication',p.status,'likes',p.likes,
            'periodViews',p.period_views,'views',coalesce(t.views,0),'rank',p.rank,'at',p.created_at,'id',p.id)
            ORDER BY p.rank ${order},p.created_at ${order},p.id ${order})
            FROM page p JOIN shorts_content c ON c.network=$1 AND c.contract=$2 AND c.id=p.id
            LEFT JOIN shorts_measurement_totals t ON t.network=$1 AND t.contract=$2 AND t.short_id=p.id),'[]'::jsonb) AS items`,
        [
          media.network,
          media.contract,
          creator,
          health.height - 2,
          start,
          end,
          query.status,
          query.q,
          cursor.position?.value ?? null,
          cursor.position?.at ?? null,
          cursor.position?.id ?? null,
          limit + 1,
          selection?.ids ?? null,
          this.chain.state.contract,
        ],
      );
      const rows: (StudioRow & { rank: number; at: number; id: string })[] =
        result.items;
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit);
      if (previous) items.reverse();
      const position = (row: (typeof rows)[number]) => ({
        value: Number(row.rank),
        at: Number(row.at),
        id: row.id,
      });
      const first = items[0],
        last = items.at(-1);
      return {
        items: items.map(
          ({ record, publication, likes, views, periodViews }) => ({
            record,
            publication,
            likes,
            views,
            periodViews,
          }),
        ),
        total: Number(result.total),
        counts: result.counts as StudioCounts,
        next:
          last && (previous ? !!cursor.position : hasMore)
            ? cursor.encode(position(last), 'next')
            : null,
        previous:
          first && (previous ? hasMore : !!cursor.position)
            ? cursor.encode(position(first), 'previous')
            : null,
        index: { ...health, confirmedHeight: Math.max(0, health.height - 2) },
        period: { days: query.days, start, end },
      };
    });
  }
}

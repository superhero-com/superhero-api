import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  DEFAULT_JOURNEY_FUNNEL_ID,
  JOURNEY_FUNNELS,
  JOURNEY_LIMITS,
  JourneyFunnel,
} from './journey.constants';
import { JourneyRange } from './journey-range';

export type FunnelStepReport = {
  index: number;
  label: string;
  event: string;
  count: number;
  /** Share of the people who did step 1, 0-100. */
  pctOfStart: number;
  /** Share of the previous step that made it here, 0-100 (null for step 1). */
  pctKeptFromPrevious: number | null;
  /** People who did the previous step but never this one (0 for step 1). */
  lostFromPrevious: number;
  /** Same as a share of the previous step, 0-100 (null for step 1). */
  pctLostFromPrevious: number | null;
  /** Median seconds between the previous step and this one (null if none). */
  medianSecondsFromPrevious: number | null;
};

export type FunnelDropOff = {
  fromIndex: number;
  toIndex: number;
  from: string;
  to: string;
  lost: number;
  pctLost: number;
};

export type FunnelReport = {
  funnel: { id: string; label: string };
  funnels: { id: string; label: string; steps: string[] }[];
  range: { start_date: string; end_date: string };
  /** Every journey event in the range; 0 drives the dashboard empty state. */
  eventsInRange: number;
  steps: FunnelStepReport[];
  /** Transitions ordered by people lost, worst first. */
  topDropOffs: FunnelDropOff[];
};

export type PageFlowRow = {
  page: string;
  views: number;
  visitors: number;
  exits: number;
  /** exits / views, 0-100. */
  exitRate: number;
  nextPages: { page: string; count: number }[];
};

export type PageFlowReport = {
  range: { start_date: string; end_date: string };
  eventsInRange: number;
  visitGapMinutes: number;
  pages: PageFlowRow[];
};

/** Pages returned by the page-flow query, worst exits first. */
export const PAGE_FLOW_LIMIT = 50;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function pct(part: number, whole: number): number {
  return whole > 0 ? round1((part / whole) * 100) : 0;
}

export function findJourneyFunnel(id?: string): JourneyFunnel | null {
  return (
    JOURNEY_FUNNELS.find(
      (funnel) => funnel.id === (id || DEFAULT_JOURNEY_FUNNEL_ID),
    ) ?? null
  );
}

export function listJourneyFunnels(): FunnelReport['funnels'] {
  return JOURNEY_FUNNELS.map((funnel) => ({
    id: funnel.id,
    label: funnel.label,
    steps: funnel.steps.map((step) => step.label),
  }));
}

/**
 * Shape per-step counts into the dashboard report. Pure, so the arithmetic is
 * tested without a database.
 */
export function buildFunnelSteps(
  funnel: JourneyFunnel,
  counts: number[],
  medians: (number | null)[],
): { steps: FunnelStepReport[]; topDropOffs: FunnelDropOff[] } {
  const start = counts[0] ?? 0;
  const steps = funnel.steps.map((step, index): FunnelStepReport => {
    const count = counts[index] ?? 0;
    if (index === 0) {
      return {
        index,
        label: step.label,
        event: step.event,
        count,
        pctOfStart: start > 0 ? 100 : 0,
        pctKeptFromPrevious: null,
        lostFromPrevious: 0,
        pctLostFromPrevious: null,
        medianSecondsFromPrevious: null,
      };
    }
    const previous = counts[index - 1] ?? 0;
    const lost = Math.max(previous - count, 0);
    const median = medians[index];
    return {
      index,
      label: step.label,
      event: step.event,
      count,
      pctOfStart: pct(count, start),
      pctKeptFromPrevious: previous > 0 ? pct(count, previous) : null,
      lostFromPrevious: lost,
      pctLostFromPrevious: previous > 0 ? pct(lost, previous) : null,
      medianSecondsFromPrevious:
        median === null || median === undefined ? null : Math.round(median),
    };
  });

  const topDropOffs = steps
    .slice(1)
    .filter((step) => step.lostFromPrevious > 0)
    .map((step): FunnelDropOff => ({
      fromIndex: step.index - 1,
      toIndex: step.index,
      from: steps[step.index - 1].label,
      to: step.label,
      lost: step.lostFromPrevious,
      pctLost: step.pctLostFromPrevious ?? 0,
    }))
    .sort(
      (a, b) =>
        b.lost - a.lost || b.pctLost - a.pctLost || a.toIndex - b.toIndex,
    );

  return { steps, topDropOffs };
}

/**
 * Strict sequential funnel in one statement.
 *
 * `s1` is each browser's FIRST occurrence of step 1 in the range; every later
 * `sN` is that browser's first occurrence of step N strictly AFTER its matched
 * step N-1. Taking the earliest match at each step is what maximises how far a
 * browser gets, so this is exact, not a sample: there is no row cap, and the
 * work is bounded by the (event, occurred_at) and (anon_id, occurred_at)
 * indexes and the 180-day range limit.
 */
export function buildFunnelSql(stepCount: number): string {
  const ctes: string[] = [
    `s1 AS (
      SELECT anon_id, MIN(occurred_at) AS t
      FROM journey_events
      WHERE event = $3 AND occurred_at >= $1 AND occurred_at < $2
      GROUP BY anon_id
    )`,
  ];
  for (let i = 2; i <= stepCount; i++) {
    ctes.push(`s${i} AS (
      SELECT p.anon_id, MIN(e.occurred_at) AS t
      FROM s${i - 1} p
      JOIN journey_events e
        ON e.anon_id = p.anon_id
       AND e.event = $${i + 2}
       AND e.occurred_at > p.t
       AND e.occurred_at < $2
      GROUP BY p.anon_id
    )`);
  }
  const selects: string[] = [
    `SELECT 1 AS step, COUNT(*)::int AS count, NULL::float8 AS median_seconds FROM s1`,
  ];
  for (let i = 2; i <= stepCount; i++) {
    selects.push(`SELECT ${i} AS step, COUNT(*)::int AS count,
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (c.t - p.t))
      )::float8 AS median_seconds
      FROM s${i} c JOIN s${i - 1} p ON p.anon_id = c.anon_id`);
  }
  return `WITH ${ctes.join(',\n')}\n${selects.join('\nUNION ALL\n')}\nORDER BY step`;
}

/**
 * Page flow from `page_view` rows: the next page view of the same browser is
 * the "next page", unless it comes more than 30 minutes later (or never), in
 * which case this view ended the visit and counts as an exit. A view whose
 * next view falls after the end of the range also counts as an exit.
 */
export const PAGE_FLOW_SQL = `
  WITH pv AS (
    SELECT anon_id, page, occurred_at,
      LEAD(page) OVER w AS next_page,
      LEAD(occurred_at) OVER w AS next_at
    FROM journey_events
    WHERE event = 'page_view' AND occurred_at >= $1 AND occurred_at < $2
    WINDOW w AS (PARTITION BY anon_id ORDER BY occurred_at, id)
  ),
  flagged AS (
    SELECT anon_id, page,
      CASE WHEN next_at IS NOT NULL AND next_at - occurred_at <= make_interval(mins => $3)
        THEN next_page END AS next_in_visit
    FROM pv
  ),
  per_page AS (
    SELECT page,
      COUNT(*)::int AS views,
      COUNT(DISTINCT anon_id)::int AS visitors,
      COUNT(*) FILTER (WHERE next_in_visit IS NULL)::int AS exits
    FROM flagged
    GROUP BY page
    ORDER BY exits DESC, views DESC, page
    LIMIT $4
  ),
  next_ranked AS (
    SELECT page, next_in_visit AS next_page, COUNT(*)::int AS count,
      ROW_NUMBER() OVER (PARTITION BY page ORDER BY COUNT(*) DESC, next_in_visit) AS rn
    FROM flagged
    WHERE next_in_visit IS NOT NULL AND page IN (SELECT page FROM per_page)
    GROUP BY page, next_in_visit
  )
  SELECT p.page, p.views, p.visitors, p.exits,
    COALESCE(
      (SELECT json_agg(json_build_object('page', n.next_page, 'count', n.count) ORDER BY n.rn)
       FROM next_ranked n WHERE n.page = p.page AND n.rn <= 3),
      '[]'::json
    ) AS next_pages
  FROM per_page p
  ORDER BY p.exits DESC, p.views DESC, p.page
`;

@Injectable()
export class JourneyQueryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async countEvents(range: JourneyRange): Promise<number> {
    const rows = await this.dataSource.query(
      `SELECT COUNT(*)::int AS count FROM journey_events WHERE occurred_at >= $1 AND occurred_at < $2`,
      [range.from, range.to],
    );
    return Number(rows?.[0]?.count ?? 0);
  }

  async getFunnel(
    funnel: JourneyFunnel,
    range: JourneyRange,
  ): Promise<FunnelReport> {
    const [rows, eventsInRange] = await Promise.all([
      this.dataSource.query(buildFunnelSql(funnel.steps.length), [
        range.from,
        range.to,
        ...funnel.steps.map((step) => step.event),
      ]),
      this.countEvents(range),
    ]);
    const counts = funnel.steps.map(() => 0);
    const medians: (number | null)[] = funnel.steps.map(() => null);
    for (const row of rows as {
      step: number;
      count: number;
      median_seconds: number | null;
    }[]) {
      const index = Number(row.step) - 1;
      counts[index] = Number(row.count);
      medians[index] =
        row.median_seconds === null || row.median_seconds === undefined
          ? null
          : Number(row.median_seconds);
    }
    const { steps, topDropOffs } = buildFunnelSteps(funnel, counts, medians);
    return {
      funnel: { id: funnel.id, label: funnel.label },
      funnels: listJourneyFunnels(),
      range: { start_date: range.start_date, end_date: range.end_date },
      eventsInRange,
      steps,
      topDropOffs,
    };
  }

  async getPageFlow(range: JourneyRange): Promise<PageFlowReport> {
    const [rows, eventsInRange] = await Promise.all([
      this.dataSource.query(PAGE_FLOW_SQL, [
        range.from,
        range.to,
        JOURNEY_LIMITS.VISIT_GAP_MINUTES,
        PAGE_FLOW_LIMIT,
      ]),
      this.countEvents(range),
    ]);
    return {
      range: { start_date: range.start_date, end_date: range.end_date },
      eventsInRange,
      visitGapMinutes: JOURNEY_LIMITS.VISIT_GAP_MINUTES,
      pages: (rows as any[]).map((row) => {
        const views = Number(row.views);
        const exits = Number(row.exits);
        const next =
          typeof row.next_pages === 'string'
            ? JSON.parse(row.next_pages)
            : row.next_pages || [];
        return {
          page: row.page,
          views,
          visitors: Number(row.visitors),
          exits,
          exitRate: pct(exits, views),
          nextPages: next.map((n: { page: string; count: number }) => ({
            page: n.page,
            count: Number(n.count),
          })),
        };
      }),
    };
  }
}

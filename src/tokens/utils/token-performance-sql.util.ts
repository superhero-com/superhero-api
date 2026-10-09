// Per-token price stats for `token_performance`. Output matches the materialized
// view it replaced (migration 1718900000027) row for row.

const WINDOWS = [
  { key: 'past_24h', volume: 'volume_24h', interval: '24 hours' },
  { key: 'past_7d', volume: 'volume_7d', interval: '7 days' },
  { key: 'past_30d', volume: 'volume_30d', interval: '30 days' },
] as const;

// A token gets a row once it has a trade, as in the view it replaced.
const hasTrades = (token: string) =>
  `EXISTS (SELECT 1 FROM transactions x WHERE x.sale_address = ${token}.sale_address)`;

type PointKind = 'first' | 'latest' | 'high' | 'low';

const ORDER_BY: Record<PointKind, string> = {
  first: 'x.created_at ASC',
  latest: 'x.created_at DESC',
  high: `(x.buy_price->>'ae')::numeric DESC, x.created_at ASC`,
  low: 'x.created_at ASC',
};

function tradesOf(alias: string, interval?: string): string {
  const since = interval
    ? `AND ${alias}.created_at > NOW() - INTERVAL '${interval}'`
    : '';
  return `${alias}.sale_address = a.sale_address ${since}
    AND ${alias}.buy_price->>'ae' IS NOT NULL AND ${alias}.buy_price->>'ae' != 'NaN'`;
}

// One index probe per token instead of a sort over every trade. `low` matches
// the minimum first: the price index runs DESC, and ties must go to the earliest trade.
function pricePoint(pick: PointKind, interval?: string): string {
  const lowest =
    pick === 'low'
      ? `AND (x.buy_price->>'ae')::numeric = (
          SELECT MIN((y.buy_price->>'ae')::numeric) FROM transactions y
          WHERE ${tradesOf('y', interval)})`
      : '';
  return `(
    SELECT json_build_object('buy_price', x.buy_price, 'created_at', x.created_at)
    FROM transactions x
    WHERE ${tradesOf('x', interval)} ${lowest}
    ORDER BY ${ORDER_BY[pick]}
    LIMIT 1
  )`;
}

function windowPoints({ key, volume, interval }: (typeof WINDOWS)[number]) {
  // Most tokens have no trades in a window; skip their probes.
  const point = (pick: PointKind) =>
    `CASE WHEN v.${volume} IS NOT NULL THEN ${pricePoint(pick, interval)} END`;
  return `
    ${point('first')} AS ${key},
    ${point('high')} AS ${key}_high,
    ${point('low')} AS ${key}_low,
    ${point('latest')} AS ${key}_latest`;
}

function windowObject({ key, volume }: (typeof WINDOWS)[number]): string {
  const first = key;
  const latest = `${key}_latest`;
  const price = (col: string) =>
    `CAST(${col}->'buy_price'->>'ae' AS DOUBLE PRECISION)`;
  const both = `${latest}->>'buy_price' IS NOT NULL AND ${first}->>'buy_price' IS NOT NULL`;
  return `json_build_object(
    'current', ${latest}->'buy_price',
    'current_date', ${latest}->>'created_at',
    'current_change',
      CASE WHEN ${both} THEN ${price(latest)} - ${price(first)} ELSE NULL END,
    'current_change_percent',
      CASE WHEN ${both} AND ${price(first)} != 0
        THEN ((${price(latest)} - ${price(first)}) / ${price(first)}) * 100
        ELSE NULL END,
    'current_change_direction',
      CASE WHEN ${both} THEN
        CASE
          WHEN ${price(latest)} > ${price(first)} THEN 'up'
          WHEN ${price(latest)} < ${price(first)} THEN 'down'
          ELSE 'neutral'
        END
      ELSE NULL END,
    'high', ${key}_high->'buy_price',
    'high_date', ${key}_high->>'created_at',
    'low', ${key}_low->'buy_price',
    'low_date', ${key}_low->>'created_at',
    'last_updated', ${latest}->>'created_at',
    'volume', ${volume}
  ) AS ${key}`;
}

const TOKEN_PERFORMANCE_SELECT_SQL = `
  WITH active AS (
    SELECT t.sale_address FROM token t WHERE ${hasTrades('t')}
  ),
  volumes AS (
    SELECT
      sale_address,
      SUM(volume) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS volume_24h,
      SUM(volume) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS volume_7d,
      SUM(volume) AS volume_30d
    FROM transactions
    WHERE created_at > NOW() - INTERVAL '30 days'
    GROUP BY sale_address
  ),
  points AS (
    -- OFFSET 0 keeps the planner from inlining this into the outer SELECT,
    -- which re-runs a probe for every reference to its column.
    SELECT * FROM (
      SELECT
        a.sale_address,
        v.volume_24h,
        v.volume_7d,
        v.volume_30d,
        ${WINDOWS.map(windowPoints).join(',')},
        ${pricePoint('latest')} AS all_time_latest,
        ${pricePoint('high')} AS all_time_high,
        ${pricePoint('low')} AS all_time_low
      FROM active a
      LEFT JOIN volumes v ON v.sale_address = a.sale_address
    ) p OFFSET 0
  )
  SELECT
    sale_address,
    ${WINDOWS.map(windowObject).join(',\n    ')},
    json_build_object(
      'current', all_time_latest->'buy_price',
      'current_date', all_time_latest->>'created_at',
      'high', all_time_high->'buy_price',
      'high_date', all_time_high->>'created_at',
      'low', all_time_low->'buy_price',
      'low_date', all_time_low->>'created_at'
    ) AS all_time
  FROM points
`;

// Unchanged rows are dropped before the INSERT: ON CONFLICT locks, and so
// rewrites the page of, every row it matches. json has no equality operator, hence ::text.
export const UPSERT_TOKEN_PERFORMANCE_SQL = `
  WITH changed AS (
    INSERT INTO token_performance (sale_address, past_24h, past_7d, past_30d, all_time)
    SELECT * FROM (${TOKEN_PERFORMANCE_SELECT_SQL}) c
    WHERE NOT EXISTS (
      SELECT 1 FROM token_performance tp
      WHERE tp.sale_address = c.sale_address
        AND (tp.past_24h::text, tp.past_7d::text, tp.past_30d::text, tp.all_time::text)
          IS NOT DISTINCT FROM
            (c.past_24h::text, c.past_7d::text, c.past_30d::text, c.all_time::text)
    )
    ON CONFLICT (sale_address) DO UPDATE SET
      past_24h = EXCLUDED.past_24h,
      past_7d = EXCLUDED.past_7d,
      past_30d = EXCLUDED.past_30d,
      all_time = EXCLUDED.all_time
    RETURNING 1
  )
  SELECT count(*)::int AS count FROM changed
`;

export const DELETE_STALE_TOKEN_PERFORMANCE_SQL = `
  WITH removed AS (
    DELETE FROM token_performance tp
    WHERE NOT EXISTS (
      SELECT 1 FROM token t
      WHERE t.sale_address = tp.sale_address AND ${hasTrades('t')}
    )
    RETURNING 1
  )
  SELECT count(*)::int AS count FROM removed
`;

import { EntityManager } from 'typeorm';

/**
 * `posts.total_comments` counts every reply below a post, at any depth, so a
 * client can show a thread's size without walking it. Hidden replies count,
 * as `GET /posts/:id/comments` returns them too.
 *
 * Each total is kept equal to the sum of 1 + total over the post's direct
 * replies, so a refresh only reads the direct replies of the posts it
 * rewrites. Recounting whole subtrees instead took over a second per reply on
 * a 1,000-deep chain. The boot recount repairs whatever a refresh missed.
 */

// Serializes recounts: one that read an older snapshot could otherwise commit
// after a newer one and leave a stale total. Distinct from the other 1-arg
// keys (…746–…749).
export const THREAD_COMMENT_COUNTS_LOCK_KEY = 4019283750;

// Bounds the writes per reply and ends a walk around a reply cycle. Real
// threads stay far below it; higher posts on a deeper chain catch up at the
// next boot recount.
export const REFRESH_MAX_HEIGHT = 1000;

// Rewrites $1 and the posts above it, lowest first: each one sums its replies
// off the walked path, plus the path below it. In a reply cycle a direct reply
// can also sit above the post, so it isn't summed; GREATEST keeps that post
// from reading as having no replies. The path check stays an uncorrelated
// NOT IN, which is hashed once; a join would rescan the path for every post.
const REFRESH_PATH_SQL = `
  WITH RECURSIVE path AS (
    SELECT id, post_id, 0 AS height FROM posts WHERE id = $1
    UNION ALL
    SELECT parent.id, parent.post_id, path.height + 1
    FROM path
    INNER JOIN posts parent ON parent.id = path.post_id
    WHERE path.height < $2
  ),
  chain AS (
    SELECT DISTINCT ON (id) id, height FROM path ORDER BY id, height
  ),
  levels AS (
    SELECT chain.id, chain.height, replies.side, replies.direct
    FROM chain
    CROSS JOIN LATERAL (
      SELECT
        COALESCE(
          SUM(1 + reply.total_comments)
            FILTER (WHERE reply.id NOT IN (SELECT id FROM chain)),
          0
        ) AS side,
        COUNT(*) AS direct
      FROM posts reply
      WHERE reply.post_id = chain.id
    ) replies
  ),
  counts AS (
    SELECT
      id,
      GREATEST(SUM(side) OVER (ORDER BY height) + height, direct)::int AS cnt
    FROM levels
  )
  UPDATE posts p
  SET total_comments = counts.cnt
  FROM counts
  WHERE p.id = counts.id
    AND p.total_comments IS DISTINCT FROM counts.cnt
`;

// When no comment or replied-to post differs from the sum over its direct
// replies, every total is exact and the rebuild is skipped. A reply cycle never
// adds up, so it rebuilds on every boot. Keep this a COUNT: written as EXISTS,
// the planner picks a fast-start nested loop that ran for minutes on 500k posts.
const COUNT_DRIFTED_SQL = `
  SELECT COUNT(*)::int AS drifted
  FROM posts p
  LEFT JOIN (
    SELECT post_id, SUM(1 + total_comments) AS expected
    FROM posts
    WHERE post_id IS NOT NULL
    GROUP BY post_id
  ) replies ON replies.post_id = p.id
  WHERE (p.post_id IS NOT NULL OR replies.post_id IS NOT NULL)
    AND p.total_comments <> COALESCE(replies.expected, 0)
`;

// Each comment's distance from its thread's root. Posts in a reply cycle have
// no root, so they keep what the refresh gave them.
const BUILD_THREAD_LEVELS_SQL = `
  CREATE TEMP TABLE thread_levels ON COMMIT DROP AS
  WITH RECURSIVE levels AS (
    SELECT reply.id, reply.post_id, 1 AS level
    FROM posts reply
    INNER JOIN posts root ON root.id = reply.post_id
    WHERE root.post_id IS NULL
    UNION ALL
    SELECT reply.id, reply.post_id, levels.level + 1
    FROM levels
    INNER JOIN posts reply ON reply.post_id = levels.id
  )
  SELECT id, post_id, level, 0 AS total FROM levels
`;

const ROLL_UP_LEVEL_SQL = `
  UPDATE thread_levels parent
  SET total = rollup.total
  FROM (
    SELECT post_id, SUM(1 + total)::int AS total
    FROM thread_levels
    WHERE level = $1
    GROUP BY post_id
  ) rollup
  WHERE parent.id = rollup.post_id
`;

// Roots aren't in thread_levels; they sum their direct replies here.
const APPLY_THREAD_LEVELS_SQL = `
  UPDATE posts p
  SET total_comments = t.total
  FROM (
    SELECT id, total FROM thread_levels
    UNION ALL
    SELECT post_id, SUM(1 + total)::int
    FROM thread_levels
    WHERE level = 1
    GROUP BY post_id
  ) t
  WHERE p.id = t.id
    AND p.total_comments IS DISTINCT FROM t.total
`;

/** Recounts `postId` and the posts above it in its thread. */
export async function refreshThreadCommentCounts(
  manager: EntityManager,
  postId: string,
): Promise<void> {
  await manager.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [
      THREAD_COMMENT_COUNTS_LOCK_KEY,
    ]);
    await tx.query(REFRESH_PATH_SQL, [postId, REFRESH_MAX_HEIGHT]);
  });
}

/** Repairs every thread's totals; returns how many changed. */
export async function recountAllThreadComments(
  manager: EntityManager,
): Promise<number> {
  return manager.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [
      THREAD_COMMENT_COUNTS_LOCK_KEY,
    ]);
    const [{ drifted }] = await tx.query(COUNT_DRIFTED_SQL);
    if (drifted === 0) return 0;

    // A hash join rescans all of posts at every level of the recursive walk:
    // a single 300-deep chain took 45s on 500k posts, index lookups 1.4s.
    await tx.query('SET LOCAL enable_hashjoin = off');
    await tx.query('SET LOCAL enable_mergejoin = off');
    await tx.query(BUILD_THREAD_LEVELS_SQL);
    await tx.query('CREATE INDEX ON thread_levels (level)');
    await tx.query('CREATE INDEX ON thread_levels (id)');
    await tx.query('ANALYZE thread_levels');
    const [{ depth }] = await tx.query(
      'SELECT COALESCE(MAX(level), 0)::int AS depth FROM thread_levels',
    );
    // Deepest first, so a reply's total is final before its parent sums it.
    for (let level = depth; level > 1; level--) {
      await tx.query(ROLL_UP_LEVEL_SQL, [level]);
    }
    // The apply is one flat join, where a hash join is the fast plan.
    await tx.query('SET LOCAL enable_hashjoin = on');
    const [, changed] = await tx.query(APPLY_THREAD_LEVELS_SQL);
    return changed ?? 0;
  });
}

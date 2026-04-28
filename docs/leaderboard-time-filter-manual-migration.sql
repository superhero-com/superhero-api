-- =============================================================================
-- Leaderboard rolling-performance feature — manual migration & deploy runbook
-- =============================================================================
--
-- The TypeORM entity decorators added in this change describe the desired
-- index shape, but production runs with `synchronize=false`. Apply this DDL
-- BEFORE shipping the new code path or rolling-window active trader discovery
-- will fall back to a sequential scan over `transactions` (potentially
-- millions of rows) and the per-metric ORDER BYs on the snapshot table will
-- not be index-backed.
--
-- All statements are idempotent (`IF EXISTS` / `IF NOT EXISTS`) so the script
-- can be re-run safely.
--
-- IMPORTANT: `CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY` cannot
-- run inside a transaction block, so do NOT wrap this script in BEGIN/COMMIT.
-- Run it with autocommit on, e.g.:
--   psql -v ON_ERROR_STOP=1 -f docs/leaderboard-time-filter-manual-migration.sql
--
-- -----------------------------------------------------------------------------
-- Pre-deploy checklist
-- -----------------------------------------------------------------------------
-- 1. Apply this script against production (or staging first) with the OLD
--    application version still serving traffic. The DDL is purely additive:
--    it only adds indexes and drops one anonymous, no-longer-referenced index.
-- 2. Wait for `CREATE INDEX CONCURRENTLY` to finish on `transactions` before
--    rolling out the new code. On large `transactions` tables this can take
--    minutes to hours.
-- 3. Verify each new index reports `indisvalid = true`:
--      SELECT indexrelid::regclass AS index, indisvalid, indisready
--      FROM pg_index
--      WHERE indexrelid::regclass::text IN (
--        'IDX_TRANSACTION_CREATED_AT_ADDRESS_TYPE',
--        'IDX_ACCOUNT_LEADERBOARD_SNAPSHOTS_WINDOW_ADDRESS',
--        'IDX_ACCOUNT_LEADERBOARD_SNAPSHOTS_WINDOW_AUM',
--        'IDX_ACCOUNT_LEADERBOARD_SNAPSHOTS_WINDOW_PNL',
--        'IDX_ACCOUNT_LEADERBOARD_SNAPSHOTS_WINDOW_ROI',
--        'IDX_ACCOUNT_LEADERBOARD_SNAPSHOTS_WINDOW_MDD'
--      );
-- 4. Only after every index is valid, deploy the new application version that
--    ranks by rolling-window performance when `timePeriod` / `timeUnit` query
--    params are supplied.
--
-- -----------------------------------------------------------------------------
-- Post-deploy verification
-- -----------------------------------------------------------------------------
-- Run these EXPLAIN ANALYZE checks against production (or a recent prod-like
-- snapshot) to confirm the planner picks up the new indexes.
--
-- A) Time-window scan over transactions (drives active trader discovery):
--      EXPLAIN (ANALYZE, BUFFERS)
--      SELECT 1 FROM transactions
--      WHERE created_at >= now() - interval '2 hours'
--        AND created_at <  now()
--        AND tx_type IN ('buy','sell');
--    Expected plan node: `Index Scan using IDX_TRANSACTION_CREATED_AT_ADDRESS_TYPE`
--    (or a Bitmap Index Scan on the same index).
--    Red flag: `Seq Scan on transactions` — index not deployed or not selected.
--
-- B) Snapshot ORDER BY (drives the read service main query):
--      EXPLAIN (ANALYZE, BUFFERS)
--      SELECT * FROM account_leaderboard_snapshots
--      WHERE window = '7d' AND aum_usd >= 1
--      ORDER BY pnl_usd DESC LIMIT 18;
--    Expected: `Index Scan using IDX_ACCOUNT_LEADERBOARD_SNAPSHOTS_WINDOW_PNL`
--    or a Sort node fed from one of the snapshot indexes (acceptable — the
--    table is small, ≤100 rows per window). Repeat for sortBy=roi/mdd/aum.
--
-- C) Hit a real rolling-performance request and inspect the duration:
--      curl 'https://<host>/api/accounts/leaderboard?window=7d&sortBy=pnl&timePeriod=30&timeUnit=minutes'
--    p95 should be well under 500ms. If it is not, capture the plan via
--    `auto_explain` (or run the underlying queries manually with EXPLAIN ANALYZE)
--    and check that `IDX_TRANSACTION_CREATED_AT_ADDRESS_TYPE` is being used.
--
-- -----------------------------------------------------------------------------
-- Rollback
-- -----------------------------------------------------------------------------
-- The new indexes are additive and safe to leave in place even if the
-- application is rolled back. To fully revert:
--   DROP INDEX CONCURRENTLY IF EXISTS "IDX_TRANSACTION_CREATED_AT_ADDRESS_TYPE";
--   DROP INDEX CONCURRENTLY IF EXISTS "IDX_ACCOUNT_LEADERBOARD_SNAPSHOTS_WINDOW_ADDRESS";
--   DROP INDEX CONCURRENTLY IF EXISTS "IDX_ACCOUNT_LEADERBOARD_SNAPSHOTS_WINDOW_AUM";
--   DROP INDEX CONCURRENTLY IF EXISTS "IDX_ACCOUNT_LEADERBOARD_SNAPSHOTS_WINDOW_PNL";
--   DROP INDEX CONCURRENTLY IF EXISTS "IDX_ACCOUNT_LEADERBOARD_SNAPSHOTS_WINDOW_ROI";
--   DROP INDEX CONCURRENTLY IF EXISTS "IDX_ACCOUNT_LEADERBOARD_SNAPSHOTS_WINDOW_MDD";
--
-- If a `CREATE INDEX CONCURRENTLY` failed partway through, it leaves an INVALID
-- index that still consumes write overhead but cannot be used by the planner:
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- Drop any such row before retrying:
--   DROP INDEX CONCURRENTLY IF EXISTS "<name>";
--
-- =============================================================================

-- 1. Snapshot table indexes ---------------------------------------------------

-- Old anonymous index that was previously declared as @Index(['window','aum_usd']).
-- TypeORM does not drop it automatically because the new declaration carries an
-- explicit name. Discover its actual name in the target environment first:
--   SELECT indexname FROM pg_indexes
--   WHERE tablename = 'account_leaderboard_snapshots'
--     AND indexdef LIKE '%(window, aum_usd)%';
-- Then drop it:
DROP INDEX CONCURRENTLY IF EXISTS "IDX_43a3f2eb87e4dca4dd1a59ba7c";

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "IDX_ACCOUNT_LEADERBOARD_SNAPSHOTS_WINDOW_ADDRESS"
  ON account_leaderboard_snapshots (window, address);

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "IDX_ACCOUNT_LEADERBOARD_SNAPSHOTS_WINDOW_AUM"
  ON account_leaderboard_snapshots (window, aum_usd);

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "IDX_ACCOUNT_LEADERBOARD_SNAPSHOTS_WINDOW_PNL"
  ON account_leaderboard_snapshots (window, pnl_usd);

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "IDX_ACCOUNT_LEADERBOARD_SNAPSHOTS_WINDOW_ROI"
  ON account_leaderboard_snapshots (window, roi_pct);

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "IDX_ACCOUNT_LEADERBOARD_SNAPSHOTS_WINDOW_MDD"
  ON account_leaderboard_snapshots (window, mdd_pct);

-- 2. Transactions table index ------------------------------------------------

-- Backs rolling-window active trader discovery:
--   WHERE t.tx_type IN ('buy','sell')
--     AND t.created_at >= $start AND t.created_at < $end
--
-- `transactions` is large; the build can take a long time. CONCURRENTLY avoids
-- blocking writes. Monitor with:
--   SELECT phase, blocks_done, blocks_total, tuples_done, tuples_total
--   FROM pg_stat_progress_create_index;
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "IDX_TRANSACTION_CREATED_AT_ADDRESS_TYPE"
  ON transactions (created_at, address, tx_type);

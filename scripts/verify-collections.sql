-- Verifies the multi-collection migration (1718900000010-TokenCollectionNameIdx)
-- and the resulting data. Run via psql against the target Postgres.

-- 1. Migration applied
SELECT name, timestamp
FROM migrations
WHERE name = 'TokenCollectionNameIdx1718900000010';

-- 2. token.collection column exists
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'token' AND column_name = 'collection';

-- 3. Index exists with the expected expression
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'token' AND indexname = 'idx_token_collection_name';

-- 4. Planner actually uses the index for the tokens.controller.ts filter
--    (look for "Index Scan" / "Bitmap Index Scan" on idx_token_collection_name,
--    not "Seq Scan")
EXPLAIN
SELECT sale_address FROM token
WHERE LOWER(split_part(collection, '-ak_', 1)) = LOWER('WORDS');

-- 5. Real data spans multiple collections, across network ids
SELECT
  split_part(collection, '-ak_', 1) AS collection_name,
  COUNT(*) AS token_count,
  COUNT(DISTINCT collection) AS distinct_collection_ids
FROM token
WHERE collection IS NOT NULL
GROUP BY split_part(collection, '-ak_', 1)
ORDER BY token_count DESC;

-- 6. Backfill progress (fix-tokens.service.ts) — should shrink toward 0
SELECT COUNT(*) AS tokens_missing_collection
FROM token
WHERE collection IS NULL;

-- 7. Sample rows to eyeball
SELECT sale_address, name, symbol, collection, created_at
FROM token
WHERE collection IS NOT NULL
ORDER BY created_at DESC
LIMIT 20;

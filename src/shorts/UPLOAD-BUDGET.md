# Retained upload budget

Hosted uploads reserve shared capacity in PostgreSQL before a new upload session
is accepted or private objects are written. The budget belongs to one network/contract. All API replicas use the
same counters; starting another process does not reset or multiply them.

Apply migration `1791763224000-ShortsUploadBudget` with the migration owner before
opening uploads. It locks the affected tables while backfilling existing upload
sessions, ingestion jobs and content, counting each ID once. Run this migration
in a coordinated maintenance window. Inconsistent historical ownership or
source sizes stop the migration for repair; no records are discarded.

## Configure

The initial budget is **50 retained uploads and 2,097,152,000 declared source
bytes** (50 × 40 MiB). Existing usage can exceed these defaults after migration;
new acceptance then pauses until the budget is explicitly raised. Existing
reserved uploads can still be processed. These defaults are safeguards, not
measured production capacity.

To choose or update a budget, add **both** values to the private environment file
used by the existing [NestJS setup command](PUBLISHER.md#configure-and-start):

```dotenv
# Setup command only; choose limits from measured storage and processing capacity.
SHORTS_MAX_RETAINED_UPLOADS=50
SHORTS_MAX_RETAINED_SOURCE_BYTES=2097152000
```

```sh
npm run build
node --env-file=/secure/publisher-setup.env dist/shorts/publisher-setup-main
```

Setup requires the trusted migration login and the existing public deployment,
publisher policy and role settings. It never needs a signing key. Omitting both
budget variables preserves the current limits; runtime API/worker environment
variables cannot overwrite them. Valid ranges are 1–1,000,000 uploads and
1–1,000,000,000,000,000 source bytes. Values must be integer decimal strings.
Raising a limit does not provision storage or increase processing concurrency.
Lowering it below current usage pauses new uploads without cancelling work.

The API role needs SELECT on `shorts_upload_budgets`, granted by setup. Do not
grant runtime roles UPDATE/DELETE/TRUNCATE on that table or any direct access to
`shorts_upload_reservations`. Admission triggers run with the migration owner's
authority and have no PUBLIC function-execution grant. Existing restricted media
workers can complete their claimed jobs without new table grants. API startup
checks that the reservation triggers are enabled and the scoped budget exists.

## What is charged

- One count and the upload's declared plaintext source size, once per ID.
- Preparation and publication reuse that reservation. Retry does not charge again.
- Failed, cancelled, expired, rejected and withdrawn uploads retain their charges.
- Legacy content without source metadata is conservatively charged its package size.
  If the original source size becomes known later, it is bound once. A smaller
  source does not refund the estimate; a larger source must reserve the difference.
- A transaction that fails before accepting an upload rolls back its reservation.
- An ignored duplicate insert does not alter the existing reservation.

There is no automatic refund or reservation deletion. Retention periods and safe
physical cleanup must be agreed and implemented before any capacity is reclaimed.
Migration downgrade refuses to discard admitted reservations.

Database triggers enforce the count and byte limits atomically. No whole-library
count is needed for each upload. Budget exhaustion returns HTTP 503 before a new
upload session is accepted. The legacy whole-file `/upload` route still receives
its bounded multipart body before reservation, but cannot write it to S3 first.
Retry the same accepted upload ID after an uncertain
response; do not create new IDs automatically. Its saved identity and immutable
input are checked before returning the previous result.

The authenticated `GET /api/shorts/operator/ingestion` response includes a `budget`
object with `maxUploads`, `usedUploads`, `maxSourceBytes`, `usedSourceBytes` and
`exhausted`. Integer values are decimal strings. A false `exhausted` flag does not
promise that a particular file will fit: its entire size must fit on admission.
Alert before either budget fills. Missing capacity information is an outage,
not permission to accept unbounded uploads.

## Independent limits

The existing hourly count/byte limits, 100 active upload sessions, eight queued or
processing jobs, two pending jobs per wallet and shared worker-processing ceiling
still apply. Active-session checks use bounded indexed queries even when retained
upload history grows. Catalog and operator review use pages; the isolated local
demo keeps its separate 50-video cap.

This is an **ingress accounting budget**, not a physical S3/disk quota. Encryption,
multipart staging, processing retries, thumbnails, HLS, key rotation, backups,
object versions, logs and duplicate writes consume additional bytes. Provision
provider/host quotas and alerts from measured amplification, and account for the
sum of all deployment budgets sharing a storage system. Keep physical disk/inode
pressure controls and storage inventories enabled. These settings alone do not
authorize production launch or additional full API replicas.

Run `npm run build`, then `npm run test:shorts:upload-budget`, with `SHORTS_TEST_PG_URL` pointing to a
disposable loopback PostgreSQL database. Tests cover migration, competing pools,
restart, retained charges, rollback, restrictive role grants and indexed admission
against retained history. They also run the compiled setup command with fixture-only credentials. They create and remove only unique fixture schemas/roles and temporary configuration files.

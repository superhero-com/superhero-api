# Shorts database workloads

Hosted Shorts uses the existing PostgreSQL database and each process's existing
database credentials. `ShortsDatabaseModule` supplies a **separate bounded pool**
for Shorts content, sessions, uploads, analytics, lifecycle/playback jobs,
publication journals, receipts and creator reads. It does not replace the main
API/indexer's `DataSource`, change database permissions or run migrations.
The plugin's shared chain indexing and dedicated LISTEN connection remain on
their existing infrastructure. The standalone SQLite demo does not load this pool.

| Setting | Behavior |
|---|---|
| `SHORTS_DB_CONCURRENCY=4` | Maximum admitted Shorts database operations per process; valid range 1–16. Excess operations fail immediately with `503`, without an application wait queue. |
| Pool acquisition | At most one second to connect/acquire; pool size equals the admission limit. |
| SQL statement | 15 seconds by default, enforced in PostgreSQL. |
| Row/table lock wait | Five seconds by default. |
| Whole operation | 25 seconds including connection, all statements, callback and commit. |
| Idle transaction | PostgreSQL terminates an idle transaction after 15 seconds. |

Use PostgreSQL 14 or newer with `client_connection_check_interval` support;
the service sets it to one second inside each transaction. This allows the server
to detect a closed client while a query is running. Verify that detection on your
actual PostgreSQL platform. Ingress, host and database resource limits remain
necessary; application deadlines are not guarantees against host/event-loop stalls.

Set the concurrency value in the API, media-worker, publisher and offline-migration
environments. Worker/publisher Compose already loads their dedicated env files.
Each process owns its pool, so size PostgreSQL's connection budget for the sum of
these limits, the normal API/indexer pool, LISTEN connections and operational
headroom. Adding replicas increases this SQL concurrency: enforce a deployment
replica budget and database role/provider limits before scaling. An unused primary
TypeORM bootstrap connection may also remain until its normal idle timeout.

Single queries and multi-statement operations run inside bounded transactions.
The hosted module completes publication, upload, analytics, playback-outbox and
lifecycle readiness checks sequentially before starting their background work.
This avoids exhausting a small SQL budget during Nest's parallel provider hooks.
A failed readiness check prevents HTTP startup and background scheduling; it
does not trigger retries or raise the configured database ceiling. The local demo
keeps its own startup hooks.

Repeatable-read analytics keep their existing snapshot; upload acceptance and
job enqueue keep the same connection and commit. Security-definer worker/publisher
functions retain their restricted login and existing authority checks. SQL logging,
entity synchronization, schema dropping and migrations are disabled on this pool.

On deadline or shutdown, the service closes the PostgreSQL socket before releasing
capacity. A late callback cannot use its released manager to write or commit.
The pool discards interrupted connections; normal SQL errors roll back before reuse.
Keep transaction callbacks limited to database work; do not put media processing,
wallet requests or remote HTTP inside them. Normal feature modules drain their
work first; a stuck database operation still has its own deadline.

**An interrupted response is not proof that a write failed.** PostgreSQL may have
committed before its acknowledgement was lost. The database layer never retries
queries or transactions automatically. Read the durable upload/job/publication
record and reuse its existing identifier when recovering; never issue a fresh
payment or signature because a database call timed out. The existing publication
journal and immutable upload references remain the recovery source of truth.

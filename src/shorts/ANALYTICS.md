# Shorts analytics and browser deletion

Hosted Shorts stores playback measurements, lifetime counters and browser-deletion
markers in PostgreSQL. Independent API connections use the same deployment-scoped
data. The loopback demo keeps its local SQLite implementation. Neither adapter
uses paid Likes as a playback-quality signal.

Financial checks are separate: [reward reconciliation](ACCOUNTING.md) compares
creator and treasury credits, claims and liabilities at one fixed contract block.

## Setup and existing data

Apply all API migrations, including `1791763207000-ShortsAnalytics` and
`1791763214000-ShortsSharedCutover`, before enabling the hosted feature. The API database role needs SELECT, INSERT, UPDATE and DELETE on
the four `shorts_measurement_*` tables. Keep them private; the media-worker login
does not need any grants on these tables. PostgreSQL and its backups contain the
measurement salt and pseudonymous browser hashes.

A new installation initializes its salt and measurement start date once. Existing
installations must migrate their local analytics deliberately:

Use the [offline legacy migration](LEGACY-STORAGE.md) while the source API is
stopped. It imports content, private media, upload state, analytics and receipts,
then records a shared completion marker. The analytics namespace must be empty
or match an earlier import. Hosted startup no longer accepts
`SHORTS_IMPORT_LEGACY_ANALYTICS` or reads a local data directory. A conflicting
source or destination never silently resets the salt, counts or deletion history.

Import reads SQLite in 500-row pages while holding its existing ownership lock.
It preserves the original salt, start date, lifetime totals, retained events and
unexpired deletion markers in one database transaction. Malformed data, missing
content or conflicting browser/video/day rows roll the import back. Expired raw
events are excluded from import, while anonymous lifetime counts are preserved.
The original local copy is not deleted by migration; include it and its backups
in the retention and erasure procedure.

Do not restart an old release against the stale SQLite snapshot after cutover.
Schema downgrade refuses to remove initialized measurement storage. Restore and
reconciliation must preserve subsequent deletion requests; restoring an older
backup by itself is not a valid privacy-recovery procedure.

## Measurement behavior

- Browser IDs are hashed with the deployment's private salt before storage.
  Raw browser IDs, IP addresses and wallet addresses are not stored in these
  measurement tables. This does not describe separate ingress or application logs.
- One event per browser/video/UTC day may qualify. Progress is monotonic, bounded
  by the video's recorded duration, signed playback evidence and elapsed server
  time. A view requires two seconds. Sub-threshold observations create no persistent
  viewer/play rows. The signed session clock anchors the first qualifying event,
  clipped to the current UTC day. Retries and concurrent updates increment the
  lifetime total only once.
- A browser may create at most 1,000 events over a rolling 24 hours. Existing event
  progress remains retryable at that limit. This is not a substitute for ingress
  limits or bot detection: clients can create new browser identities.
- Reach estimates browsers, not people. Reports aggregate in PostgreSQL and return
  only summaries, per-day/per-video metrics and source groups. Source counts are
  suppressed below five browsers. Supported windows are 7, 28 and 90 days.
- Recent engagement averages quality within each browser before combining browsers;
  small samples retain the existing neutral prior. These measurements are estimates,
  not proof of genuine attention and not financial accounting.

## Operational monitoring

`GET /api/shorts/operator/measurements` requires an operator session and returns
`Cache-Control: no-store`. It needs no new environment variables or service.
The response is explicitly **per API process**, identified by a random `instance`
value that changes after restart. Scrape each replica directly; a load-balanced
URL cannot provide complete deployment totals. Keep monitoring credentials in
the existing operator authentication system, never in browser bundles or logs.

`cumulative` contains fixed counters since that process started. `recent` holds
at most twelve five-minute buckets, with `from`, `until` and `partial` describing
their observation intervals. The monotonic process clock prevents wall-clock
adjustments from recycling a bucket. Inactive buckets age out on read; there is
no timer, database write or cleanup job. No IPs, browser/wallet identifiers,
proofs, video IDs or arbitrary labels enter these counters. Counter saturation
is explicitly reported by `saturated`, rather than wrapping silently.

| Counter | Meaning |
|---|---|
| `accepted_update` | An authenticated progress update returned accepted. Repeated heartbeats count; this is **not views or people**. |
| `ignored_below_threshold` | Authenticated evidence was below two seconds and ignored without persistent measurement writes. |
| `rejected_duplicate_or_forgotten` | The store declined an event, including duplicate daily identities or privacy replay barriers. |
| `invalid_request` | Invalid measurement fields or request identity syntax. |
| `invalid_evidence` | Missing, malformed, mismatched or expired playback evidence. |
| `content_unavailable` | The Short is not currently eligible for playback. |
| `rate_limited` | Admission rejected a playback request with 429 before the controller ran. |
| `service_unavailable` | Admission, content/evidence or measurement dependencies returned 503. |
| `server_error` | Another unexpected failure occurred. |

Use counter deltas and bucket durations, not cumulative totals, to compare rates.
Repeated `service_unavailable`/`server_error` increments need dependency and error
investigation; increases in `invalid_evidence`, ignored observations, duplicate
events or 429s indicate traffic worth inspecting. They can also reflect expired
tabs, retries or ordinary capacity pressure. Do not automatically label users as
bots, alter rewards or change content eligibility from these signals. Full-segment
clients rotating browser identities may still resemble legitimate viewers.

Configure thresholds and alert routing in the deployment's monitoring system,
assign an investigation owner, and test missing scrapes and process resets.
The in-memory endpoint neither sends alerts nor stores durable monitoring history;
those deployment checks remain necessary. Requests rejected by the web server
before the Shorts guard (for example an oversized JSON body) are visible only in
ingress/server metrics. Financial reconciliation uses canonical chain events and
balances separately; these counters never determine earnings or paid Likes.

## Creator reports

`GET /api/shorts/performance?days=28` requires a creator session and returns
`Cache-Control: no-store`. The server selects the creator from that session;
an address query cannot select someone else's analytics. Add `short=<id>` for
one owned video. Missing and non-owned IDs both return 404.

Hosted reports join the content registry inside PostgreSQL. They never load the
whole library's IDs or browser events into API memory. Account totals, distinct
browser reach, daily charts and source groups cover the entire owned library in
the selected period, including previously watched withdrawn videos. Financial
totals still come from the existing chain index and retain its freshness markers.

The `videos` breakdown selects at most 100 videos by period views,
then creation time and ID. Videos with no measured views can have zero values.
`videoBreakdown` reports the library's `total`, the number `returned`, and whether
the breakdown is `complete`. Never calculate account totals by adding that
breakdown or interpret an omitted video as having zero views. A selected-video
request returns just that owned video's full report. The capped local adapter
retains its original complete-library report.

Playback metrics use one repeatable-read snapshot, including registry ownership
and retained events. Concurrent deletion is reflected in the next report; a report
already reading its snapshot may finish with its earlier counts. Reports use the
same four-request admission bound as catalog reads, with no waiting queue. SQL
lock/statement deadlines apply; these bounds do not establish measured production
capacity or distributed rate limiting. Studio content pagination and account
summary migration remain separate from this analytics query.

## Deletion and retention

`POST /api/shorts/analytics/forget` deletes retained playback for the supplied
browser session and subtracts its retained qualified views. The deletion marker,
counter adjustments and raw-event removal commit together. A database failure
fails the request rather than acknowledging a deletion that was not saved.
Concurrent measurement uses the same per-browser lock. A salted marker rejects
that session's delayed events for 24 hours across API restarts and instances.
The browser must stop using the deleted session; a new session is a new identity.

Reports and ranking immediately exclude raw events older than 90 days, even if
physical cleanup is delayed. A background pass every five minutes removes up to
5,000 expired events and 5,000 unused viewer rows. Passes use row locks with
`SKIP LOCKED`; the API does not buffer the full history. Database outages or a
large backlog can delay physical deletion and must be monitored operationally.
Lifetime counters survive expiry without browser attribution; expired anonymous
totals cannot later be attributed to a browser for subtraction.

Database operations have five-second lock waits and fifteen-second statement
limits. Cleanup drains on shutdown. The feature's single-instance API restriction
still applies pending deployment/load validation. Upload ingress uses a shared,
configurable [retained upload budget](UPLOAD-BUDGET.md), separate from analytics
retention and physical storage quotas. Signing uses the separate
[publisher](PUBLISHER.md); [transaction history](RECEIPTS.md) also uses PostgreSQL.

`npm run test:shorts:measurements` uses a disposable loopback PostgreSQL database
set by `SHORTS_TEST_PG_URL`. It exercises concurrency, transactional failure,
privacy replay barriers, migration and independent HTTP API instances. It does
not certify traffic authenticity, legal compliance, backup erasure or production
load capacity. Review the actual collection notices and retention requirements
before exposing the feature to release traffic.


Hosted owner reports also include `topShorts`: metadata for at most five top-viewed
Shorts in the selected period, selected from that report's bounded video breakdown.
The web uses it to link older performers that are outside the latest Studio summary.
The independent Studio library endpoint supplies its own period views and global
sorting; do not join the limited analytics breakdown to calculate library totals.

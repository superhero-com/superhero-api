# Shorts catalog pages

The catalog offers bounded pages for clients migrating off the original
whole-library endpoints. Apply the Shorts metadata migrations, including
`1791763211000-ShortsCatalog`, through the API's normal TypeORM migration command.
This migration adds a partial public-catalog index and does not change content.

## Endpoints

Paths below are relative to the application's `/api` prefix, including the isolated
local preview (for example, `http://127.0.0.1:3334/api/shorts/feed`).

| Request | Access | Result |
| --- | --- | --- |
| `GET /shorts/feed?address=<wallet>&cursor=<next>` | Public; wallet is optional | Eligible public candidates and the wallet's Like state |
| `POST /shorts/feed/state` | Public; body `{ "ids": [...], "address": "optional wallet" }` | Current eligible metadata for up to 20 distinct IDs |
| `GET /shorts/feed/following?address=<wallet>&cursor=<next>` | Public; wallet required | Eligible videos across the account's followed creators |
| `POST /shorts/feed/following/state` | Public; body `{ "ids": [...], "address": "wallet" }` | Up to 20 current eligible followed videos, plus membership revision |
| `GET /shorts/content?cursor=<next>` | Creator bearer session | That creator's drafts and published or withdrawn content |
| `GET /shorts/review?cursor=<next>` | Operator bearer session | Up to 20 videos across all review and publication states |

The GET endpoints return `{ "items": [...], "next": "..." }`. The state endpoint returns `{ "items": [...] }` and omits missing, private or ineligible IDs. `next` is `null` at the end.
Omit the cursor on the first request. All responses use `Cache-Control: no-store`.
The server selects the creator from the authenticated session; an address query
cannot select another creator's private library.

Review pages authenticate the operator on every request, including continuation.
They return review fields and an authenticated preview path, without private S3
references or file manifests. They do not query the blockchain per video. Review
cursors cannot be reused on the public feed or creator library. A cursor never
preserves access after the operator's authorization is revoked.

A request scans at most 20 candidates, enriches at most four at a time, and never
walks additional pages to fill an empty result. A page may have no items and still
have a `next` cursor because safety or chain checks removed its candidates. Clients
must offer continuation or fetch a bounded number of subsequent pages; do not
automatically drain the whole catalog. Extra `limit` parameters do not raise the
fixed page size.

## Ordering and freshness

Pages use descending creation time and ID, with a strict continuation position.
Those fields are immutable. Newer uploads do not displace the continuation position.
This is a live catalog, not a database snapshot: policy changes can remove records
between requests, and an older newly approved record may join a later page. Restart
from the first page to discover newly available records before the cursor.

Cursors bind the deployment, endpoint and wallet context. They are validated query
positions, not secrets, signatures or authorization. Changing wallet or deployment
requires a fresh first page. The database always applies the server-selected scope
and authenticated creator independently of cursor contents.

Public PostgreSQL pages first select approved, published metadata using the partial
index. Current serving policy and on-chain identity/withdrawal are checked before
returning a candidate, and policy is rechecked after asynchronous enrichment. Private
media references, scan evidence and storage filenames are not returned. Playback
still performs its own authorization and confirmation checks; catalog visibility
does not grant media access. Recommendation ranking belongs above this chronological
candidate source and must not allow payment to bypass eligibility.

## Following setup and consistency

The hosted API advertises `followingPaging: true`. This indicates endpoint support,
not that the social index is currently ready. Configure the existing
`SOCIAL_GRAPH_CONTRACT_ADDRESS` and `SOCIAL_GRAPH_NETWORK_ID` for the same network
as Shorts; the current Shorts deployment supports testnet only. Following reuses
the social plugin's bytecode/network verifier through the bounded Shorts node
transport. It reads the plugin's `social_graph_projection_scopes` and
`social_graph_projection_edges` tables using the bounded Shorts SQL pool. The API
database role needs SELECT on those two tables; no new service, key or writable
follow store is required. The existing social-graph worker remains their writer.

Apply `1791763227000-ShortsFollowing` through the normal migrations before enabling
the new release. Its partial creator index supports seeking within each followed
creator's published, approved videos. Each creator contributes at most 21 rows
before the global chronological page is selected. Unrelated uploads and private
drafts are not walked by the client. SQL execution remains subject to the shared
database admission/deadlines; workload still scales with the account's graph size.

Only the newest ready projection generation can serve Following. An unconfigured,
rebuilding or unavailable graph returns an error rather than falling back to recent
videos or a stale generation. Both block directions exclude the creator. Public
content and canonical on-chain media checks are the same as the normal feed;
membership is rechecked after those asynchronous reads.

Following page and state responses also return `revision`, an opaque version of
the account's relevant graph edges. Cursors bind that revision, the viewer and
the Shorts deployment. The projection serializes mutations within each generation
and assigns new edge IDs; the version derives from that generation and the count
and maximum ID of the account's following/block edges, including incoming blocks.
It does not depend on transient dirty/reconciliation rows. A changed revision
invalidates old continuation and lets periodic state refresh recover missed socket
updates, including an empty feed. A graph change during page enrichment returns
409; restart at page one. After generation/membership changes an old cursor returns
400, and a rebuilding graph returns 503. These versions describe the committed
index, not unconfirmed wallet actions or a guarantee that the index has no lag.

Run `npm run test:shorts:following` with an isolated loopback `SHORTS_TEST_PG_URL`
for migration, pagination, block/unfollow, generation and HTTP checks. It creates
and removes only its own schema; chain identity inputs are controlled test doubles.

## Capacity and client migration

The API admits four catalog/review/creator-performance requests per process and returns HTTP 503 on excess
work, with no in-process waiting queue. On an upstream failure it waits for already
started reads to finish before releasing admission. This is a concurrency bound,
not a distributed rate limiter, chain timeout or production load guarantee.

In the hosted API, the original `GET /shorts` and `GET /shorts/dashboard` return
HTTP 410 before reading the library or querying the node. Use `/shorts/feed` and
the Studio endpoints below. They do not return a silently truncated first page.
Whole-library record reads are disabled in hosted services. The isolated local
adapter retains the original response shapes and its 50-record capacity guard.
The web feed selects the new endpoints when `/shorts/config` advertises
`catalogPaging: true`. It retains at most 60 metadata records, uses at most 20 IDs
per refresh request, and never loads the private dashboard while watching.
Automatic look-ahead is limited to three pages per active video; explicit retry or
continuation is available for an empty or filtered window. The latest-feed action
starts again at the first page. Playback mounts at most five video elements and
warms at most three HLS players, independently of the metadata window.

Hosted creator [performance reports](ANALYTICS.md#creator-reports) now aggregate the
whole owner library in SQL and return a bounded, explicitly marked video breakdown.
Hosted Studio uses the independent summary and library endpoints below. Storage
admission uses the shared [retained-upload budget](UPLOAD-BUDGET.md); these reads do not authorize increasing capacity or
enabling multiple API replicas. Older APIs
without the capability flag use the existing capped feed response. The content page is a library slice;
never compute whole-account totals from just its items.

Run `npm run test:shorts:catalog` for the catalog tests. Set `SHORTS_TEST_PG_URL` to
an isolated loopback PostgreSQL database to include the migration and multi-connection
tests. The suite creates and removes a unique schema; it does not need a wallet or
a live blockchain. Loopback HTTP binding is required for the controller tests.

The local operator console also uses the paged review response:
`npm run shorts:review -- list` prints one page and a continuation command when
more results exist. Run that command to fetch the next page. It never downloads
all review records into memory. The approval/restriction commands are unchanged.


## Creator Studio read model

When config advertises `studioPaging: true`, authenticated Studio clients use:

- `GET /shorts/studio/summary?days=28`: live wallet/account balance, latest four
  Shorts, whole-library publication/restriction counts and index freshness.
- `GET /shorts/studio/content?days=28&q=&status=all&sort=newest`: at most 20
  creator records, filtered total, whole-library counts, period views and opaque
  `next`/`previous` cursors. `status` is `all`, `published`, `draft`, or `withdrawn`.
  Sorts are `newest`, `oldest`, `likes`, `likes-asc`, `views`, `views-asc`.
- `GET /shorts/studio/video/:id?days=28`: one owned Short, including private
  Studio fields, independent of the latest-summary window; non-owned IDs return 404.

All three require the signed creator session, select the wallet from that session,
return `Cache-Control: no-store`, and share catalog admission. Query addresses and
cursor contents cannot change ownership. Days must be 7, 28 or 90. Search is a
literal case-insensitive substring of title/topic, at most 100 characters.

The read service queries existing `shorts_chain_events` written by the Shorts
indexing plugin. It does not add a chain listener or fetch every video's state
from the node. Publication, withdrawal and Likes require three confirmations;
canonical transaction deletion removes their projection on rollback. Withdrawn
metadata remains withdrawn. A metadata publication without a confirmed Published
event remains a draft/pending publication in this read model. An incomplete,
failed or stale index is explicitly reported. Clients display that lag; wallet
balances remain separately read from the node. Playback and mutations retain their
own verification and do not trust a catalog row as authorization.

A REPEATABLE READ transaction gives each response consistent counts, index height,
rows and period measurements. Library views come directly from the selected UTC
period, not the bounded analytics breakdown. Only the selected page's record bodies
and lifetime totals are returned. `1791763212000-ShortsStudio` adds the per-video
chain-event lookup index. Global sorting/counting still has database cost; measure
it with the expected data volume before raising upload admission.

Cursors bind the wallet, deployment, search, status, sort and period. Reset to the
first page when any of those change. Sort ties use creation time and ID. This is
live pagination, not a multi-request snapshot: new uploads, views, Likes or rollbacks
can move items across pages. Refresh or restart to see changes; do not infer totals
from visible rows or claim stable page numbers. Clients keep one library page,
abort obsolete reads, discard previous-account/deployment responses and offer retry.
Legacy/local config without `studioPaging` retains the capped dashboard.

Run `npm run test:shorts:studio-read` with the isolated `SHORTS_TEST_PG_URL` described
above for database paging, rollback, count, sorting and authenticated HTTP checks.

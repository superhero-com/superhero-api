# Shared Shorts request limits

Hosted Shorts uses the API's Redis infrastructure for request budgets shared by
all API instances. The limiter runs as a Nest guard before controller work and
multipart parsing. PostgreSQL upload admission, publisher spending limits and
worker leases remain authoritative for accepted work. Redis counters are temporary
traffic controls, not financial accounting or proof of production capacity.

## Configure

1. Configure the normal `REDIS_HOST`, `REDIS_PORT` and optional `REDIS_PASSWORD`.
   Keep Redis on a private network and require authentication for remote access.
   Use `maxmemory-policy noeviction`, monitor memory and size it for all consumers.
   An unavailable or full Redis causes controlled 503 responses, never a local
   quota fallback. Restarting Redis or evicting its keys resets traffic budgets.
2. Generate a dedicated 32-byte random key as 64 lowercase hexadecimal characters
   in an owner-only file outside Git. Set `SHORTS_RATE_KEY_FILE` to its absolute
   path. The API process UID must own and read it; symlinks and group/other access
   are rejected. Mount the **same key** in every API instance. No media worker,
   publisher, browser or mobile client needs it. Do not reuse a wallet, storage or
   encryption key. Coordinate rotations across instances: rotation resets
   per-client buckets, while deployment-wide budgets remain shared.
3. Configure `TRUST_PROXY` with explicit proxy IPs/CIDRs, for example
   `127.0.0.1/32,10.20.0.10/32`. Use only the actual trusted proxy hops. For direct
   access, leave it unset or set `false`. Shorts rejects `true`, numeric hop counts,
   broad presets and `/0` ranges. The proxy must overwrite or correctly append
   `X-Forwarded-For`; restrict direct origin access at the firewall.
4. Apply the same release and limits to every API instance. Start the normal API
   with `ENABLE_SHORTS=true`. Startup verifies the key, proxy configuration and
   Redis connectivity. The standalone loopback demo does not create this client.

Shorts resolves the client from the socket and the explicit proxy chain; it never
uses an arbitrary header or a permissively resolved `req.ip`. It stops at the
nearest untrusted hop. IPv4-mapped IPv6 addresses share the IPv4 budget; IPv6
interface addresses share a /64 budget. This limits address rotation but can group
households or organizations. Invalid trusted forwarding data returns 400.

## Budgets

Buckets allow an initial burst and refill continuously using Redis's clock. A
period below is the time to replenish an empty bucket. Requests to different video
IDs share the same endpoint-family budget. Limits are defined in
`shorts-rate-policy.ts`; revise them with measured capacity and a coordinated
rollout. They are not knobs for disabling abuse protection.

| Endpoint family | Client IP burst | Verified wallet burst | Deployment burst | Full refill |
|---|---:|---:|---:|---|
| Feed, config, shared metadata | 300 | — | 3,000 | 1 minute |
| Playback descriptors | 1,200 | — | 6,000 | 1 minute |
| Playback dependency health | 30 | — | 120 | 1 minute |
| Sign-in and logout | 20 | 20 for logout-all | 120 | 1 minute |
| Studio, upload/publication status | 240 | 180 | 1,200 | 1 minute |
| Playback measurements and legacy view reads | 180 | — | 3,000 | 1 minute |
| Forget analytics | 6 | — | 120 | 1 minute |
| Reports | 6 | — | 120 | 1 minute |
| Start upload | 12 | 6 | 60 | 1 minute |
| Legacy upload parts | 120 | 100 | 600 | 1 minute |
| Direct upload prepare / authorize / complete | 360 | 300 | 1,800 | 1 minute |
| Finish upload / publish (separate buckets) | 12 | 6 | 30 | 1 minute |
| Transaction acknowledgement | 30 | 20 | 120 | 1 minute |
| Rescan / appeal (separate buckets) | 6 | 3 | 60 | 1 hour |
| Operator actions | 60 | 60 | 120 | 1 minute |
| Private video previews | 60 | 60 | 120 | 1 minute |

Private endpoints first debit the client-IP bucket and a shared 3,000/minute
pre-authentication budget. Only successful authentication debits the wallet and
operation-wide budget. Operator actions also verify operator authority first.
Private previews use their own bucket and require the video's creator or an
operator before any media read; they do not make all Studio users operators.
Unauthenticated attempts cannot consume the authenticated operation allowance.
An exhausted pre-authentication budget still limits all private admission; ingress
DDoS controls and a restricted operator network remain necessary.

Hosted binary upload routes reject before multipart parsing; their parser budgets
remain for legacy adapters. Direct uploads reserve the declared whole-file bytes in
PostgreSQL before any permission is issued, and freeze a single object/checksum per
part. Storage independently enforces each signed length and checksum. Rate-limit
the public storage ingress too: repeated or concurrent signed PUT requests consume
storage bandwidth even when conditional writes prevent duplicate objects.

Legacy multipart routes additionally share byte reservations: **128 MiB per
client IP, 80 MiB per wallet and 512 MiB deployment-wide**, replenished over ten
minutes. Each part reserves the parser maximum of 1 MiB + 1 byte; the compatibility
full-file route reserves 40 MiB. Reservations happen after authentication and before
parsing, including chunked uploads without a length header. Failed/cancelled
requests retain their reservation; it refills normally. This conservative allowance
is not a measurement or bill for bytes stored. Declared bodies over the media limit
plus 64 KiB multipart overhead are rejected. File/field parser limits and body
receive deadlines still apply.

## Failure and operational boundaries

- 429 includes `Retry-After` in seconds and `Cache-Control: no-store`. Retry after
  that interval using the same upload/publication identity; do not create duplicate
  jobs or signatures. A successful earlier phase may consume its allowance even
  if a later authorization, validation or operation fails.
- Each Redis decision atomically checks/debits its budgets. Rejected decisions
  neither create fresh client keys nor partially debit another bucket. Global
  admission bounds the number of accepted per-client keys. Every counter expires
  after at most its full-refill period following accepted use (one hour maximum).
- Per-client Redis keys contain HMAC digests, never raw IPs, wallet addresses,
  bearer tokens or browser IDs. The secret prevents trivial address enumeration.
  This statement does not cover separate ingress/application logs or Redis backups.
- The limiter admits at most 32 concurrent Redis commands per API process, with
  one-second connect/command deadlines and no offline queue or replay of unfinished
  commands. On a command failure it drops that connection before admitting more
  work. Reconnection needs a live Redis response. Shutdown closes the client and
  drains its pending decisions.
- The Redis identity needs connection/readiness commands (`AUTH` when enabled,
  `PING`, `INFO`, and connection metadata commands supported by the client), plus
  `EVAL`, `TIME`, `HMGET`, `HSET` and `PEXPIRE` restricted to
  `shorts:rate:v1:*` keys. The dedicated live-update limiter also uses
  `ZADD`, `ZSCORE`, `ZCARD`, `ZREM`, and `ZREMRANGEBYSCORE` on `shorts:ws:v1:*`. Validate the effective ACL with your Redis version and
  the actual deployed client. Do not give a browser or decoder these credentials.
- Shared rate limits do not provide Sybil resistance, protect untrusted direct
  origin exposure or replace network connection limits. Global budgets can be
  exhausted under sustained abuse. HTTP JSON parsing still uses the API's normal
  bounded parser before Nest guards; ingress must constrain slow connections and
  request-body sizes. Streaming-service playback sessions and the dedicated WebSocket transport
  use separate limits; these HTTP budgets do not cover them.
- Keep one API instance and the current content cap until aggregate upload
  concurrency, publication throughput, provider/role configuration and load/recovery
  tests support expansion. Shared counters alone do not make the release ready.

## Live updates

The `/shorts` Socket.IO namespace uses its own Engine.IO transport at
`/shorts/socket.io/`. Forward WebSocket upgrades on that path to the API and keep
the main `/socket.io/` route unchanged. A public URL prefix must be stripped by
the proxy before forwarding; the web client preserves that prefix in its requests.
Only direct WebSocket connections are accepted; polling and session-ID reuse are
rejected. Apply TLS, connection/header deadlines, origin access restrictions and
network connection limits at ingress as well.

Admission runs before creating the connection and uses the same private Redis,
`SHORTS_RATE_KEY_FILE` and explicit proxy policy as HTTP admission. Counts are
scoped to network and contract across API instances. Defaults in
`shorts-socket.service.ts` are:

| Control | Default |
|---|---:|
| Simultaneous connections per client IP | 20 |
| Simultaneous connections per deployment | 1,000 |
| Simultaneous connections per API process | 250 |
| Handshake burst per client IP / deployment | 60 / 6,000 |
| Handshake bucket full refill | 1 minute |
| Redis lease / renewal interval | 30 seconds / 10 seconds |
| Pending admission decisions per process | 32 |
| Incoming message limit | 4 KiB |

Clients without a joined namespace still occupy a slot and must join within five
seconds. Leases expire after a crash; orderly disconnects release them early.
Renewal cannot revive an expired lease. Redis outages deny new connections and
close live Shorts connections; other application sockets are independent. The
Redis client bounds commands to one second with no offline queue or replay.
A timeout may have reserved a slot even though admission was not acknowledged;
that slot expires with its lease. Restarting/evicting Redis resets admission state:
coordinate API draining and restart, rather than assuming old sockets survived
with valid quotas. Use the same key, limits and version across instances.

The transport only broadcasts small network/contract invalidations, coalesced over
100 ms. It does not accept client commands; unsupported or oversized messages
close that Shorts connection. Browser origins must match `ALLOWED_ORIGINS` when an
explicit allowlist is configured. Origin checks are not authentication or bot
prevention. Rejected WebSocket upgrades return Engine.IO's generic 400 response or
close on timeout, not the HTTP limiter's 429 response. The web client retries with
jittered exponential backoff capped at 30 seconds and retains periodic HTTP
refreshes. A lost invalidation is recovered by refetching state, not event replay.

These are conservative guardrails, not a tested public capacity promise. Review
real client/proxy distribution before changing them; shared-address users share
one client allowance. Global limits can be exhausted by sustained abuse.

## Upload capacity

Hosted multipart uploads, resumable parts and finish requests acquire a shared
reservation before parsing. `SHORTS_CONCURRENT_UPLOADS` is the per-process ceiling
(default 2, maximum 8); `SHORTS_SHARED_CONCURRENT_UPLOADS` is the deployment-wide
ceiling (default 4, maximum 64). Every authenticated wallet has one concurrent
request across replicas. Reservations use deployment-scoped Redis keys; wallet
identifiers are HMACed with `SHORTS_RATE_KEY_FILE`. Existing HTTP request/byte
budgets apply independently.

A lease lasts 30 seconds and renews every 10 seconds, with a conservative local
deadline. Renewal cannot resurrect expired ownership. Redis failures deny new
requests and cancel uncertain active IO; at most 32 admission commands wait per
process, each bounded to one second with no offline queue or automatic replay.
The owner releases its reservation only after parsing/controller work settles.
An unknown acquisition may occupy capacity until expiry. A stale release cannot
remove another request's wallet reservation.

All replicas must use the same shared ceiling, rate key and lease policy. A
persistent policy fingerprint rejects inconsistent replicas. To change the ceiling
or rotate the rate key, stop/drain every API, wait at least 30 seconds for old
reservations to expire, then remove only the `shorts:upload:v1:{SCOPE}:policy` key
through the authorized Redis operations connection. `SCOPE` is the first 32 hex
characters of SHA-256 of `ae_uat:CONTRACT_ADDRESS`. Restart all instances with the
new matching configuration; the first acquisition records the new policy. Do not
clear active reservations to force capacity, flush Redis or run mixed old/new
releases. No raw wallet/session token or signing key is stored in this policy.

The body deadline remains separate from the total request deadline. Total expiry,
lease loss and shutdown propagate cancellation through the hosted adapter to
private S3. Already-committed object or PostgreSQL operations cannot be rolled
back by HTTP cancellation: the API waits for the handler to settle, and immutable
part references plus idempotent finish allow same-upload recovery. A response
lost after commit is an uncertain result, not proof of failure. Completed-body
client disconnects alone do not cancel accepted work.

Logical leases do not provide a physical resource guarantee during an OS pause,
Redis loss/eviction, or unresponsive database operation. Keep dedicated
non-evicting Redis, trusted ingress connection/body/timeout limits, bounded DB
connections/query deadlines, CPU/memory caps and coordinated Redis recovery.
These settings do not remove the single-API deployment restriction or replace the shared [retained-upload budget](UPLOAD-BUDGET.md). Budget defaults remain conservative until measured capacity supports changing them.

## Shared media transfers

`SHORTS_SHARED_CONCURRENT_MEDIA=2` limits hosted private previews, rescans,
package pinning and integrity-recovery reads across API instances. One creator
can hold one media transfer at a time. Admission occurs before loading private
bytes; nested package operations reuse the same permit. This uses the existing
Redis and rate key, with a separate `shorts:media:v1:{SCOPE}` namespace. There
is no new service or credential. Missing admission fails closed in hosted mode.

Permits last 30 seconds and renew every ten seconds, with a conservative local
expiry. Each media operation has a three-minute deadline. Lease loss, cancellation
and shutdown stop new IO and signal active transfers; a normal release waits for
started work to drain. A killed process leaves a permit until expiry. Capacity
shortages return a retryable 503; lifecycle work records `capacity_wait` and tries
again after 15 seconds without spending failure retries. Temporary scanner
unavailability is also deferred rather than recorded as safety evidence.

All API instances must use the same ceiling, lease policy and rate key. Policy
disagreement rejects work. To change this ceiling or rotate the key, stop/drain
every API, wait at least 30 seconds, remove only the corresponding
`shorts:media:v1:{SCOPE}:policy` key through the authorized operations connection,
then restart with matching configuration. `SCOPE` uses the upload formula above.
A shared-key rotation requires coordinating both upload and media policies. Do
not mix releases that enforce admission with older releases that bypass it.

Upload admission and initial media-worker processing have separate budgets;
size the deployment for their combined resource use. Small IPFS health/pin-status
queries are not bulk transfers. Preview admission ends after its buffer is loaded,
so slow HTTP clients still need ingress and response limits. Redis leases cannot
stop a paused process or a remote operation that ignores cancellation. Redis
reset/eviction requires coordinated draining and recovery, not live capacity
reset. Keep non-evicting Redis, host resource limits and the single-API deployment
restriction until measured, full-pipeline validation supports scaling.

## Verify changes

`npm run test:shorts:rates` checks proxy handling, secret configuration and policy
coverage. Set `SHORTS_TEST_REDIS_URL` to an **isolated disposable loopback Redis**
and `SHORTS_TEST_REDIS_DISPOSABLE=1` for the two-instance HTTP/Redis suite. It creates
scoped keys and pauses that Redis server to test deadlines and recovery. Never point
it at an application Redis. The normal Shorts unit and index suites cover the
feature's disabled/local/hosted wiring.

`npm run test:shorts:sockets` starts its own disposable loopback Redis and Nest
servers. It checks admission across instances, origin/proxy handling, lease
expiry/renewal, overload, outages, malformed traffic and isolation from the main
application socket. A local `redis-server` executable is required.

`npm run test:shorts:upload-capacity` starts disposable Redis and two local Nest
servers. It verifies cross-instance capacity/ownership, expiry, delayed or lost
acknowledgements, shutdown and private S3 HTTP cancellation/resume. A local
`redis-server` is required. The worker/storage suites separately validate actual
PostgreSQL and S3-compatible persistence and recovery.

`npm run test:shorts:media-admission` starts disposable loopback Redis and Nest
contexts to check shared media capacity, policy mismatch, cancellation, shutdown
and killed-owner recovery. A local `redis-server` is required. Setting
`SHORTS_TEST_PG_URL` to disposable loopback PostgreSQL also tests the migration,
durable capacity waits and retry recovery. Private media, scanner and pinning
callbacks in this suite are controlled fixtures; provider integration is tested
separately.

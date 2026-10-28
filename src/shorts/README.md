# Shorts testnet MVP

[Direct uploads](DIRECT-UPLOADS.md) send encrypted video chunks from the browser to MinIO,
with the API handling permissions and completion metadata only.

Private shared upload storage is documented in [PRIVATE-STORAGE.md](PRIVATE-STORAGE.md),
including module boundaries, S3 configuration, secret files and provider requirements.
[Database workload limits](DATABASE.md) describe the separate Shorts pool, deadlines and recovery semantics.
[Retention operations](RETENTION.md) document the separate reference-inventory and hold command; automatic storage deletion remains disabled.
[Private storage inventory](STORAGE-INVENTORY.md) lists S3 versions and delete markers with durable scan checkpoints and no object-deletion authority.
[Optional multipart inventory](MULTIPART-INVENTORY.md) observes unfinished provider-side uploads and parts; creator uploads still use ordinary object writes.
[Storage reference reconciliation](STORAGE-REFERENCES.md) expands encrypted manifests and matches logical references and holds to a completed inventory, without deleting media.
[HLS index inventory](HLS-INVENTORY.md) matches prepared streaming packages to source references and holds with resumable read-only Redis scans.
[Reward reconciliation](ACCOUNTING.md) compares indexed creator/treasury rewards and claims with contract state at a fixed block.

An opt-in NestJS feature module connected to a real æternity testnet contract. It can run inside the normal API on staging, or separately for local development without the main databases and relays. The web feature runs within Superhero's existing application and wallet providers.

## Enable on staging

Shorts is disabled by default. Set **`ENABLE_SHORTS=true`** on the API to load its
routes, storage and background tasks. All other values leave them unloaded.
Restart after changing the flag. The standalone development entrypoint requires
the same flag. Turning it off preserves saved data.

The normal API entrypoint supports a **single testnet staging instance** with
Node 22.13+, `AE_NETWORK_ID=ae_uat`, `SHORTS_TESTNET_MVP=1`,
`NODE_ENV=production` and `SHORTS_WEB_ORIGIN` set to the exact HTTPS website origin.
The hosted API uses PostgreSQL and private S3 and must not set `SHORTS_DATA_DIR`.
Decoding runs in the separate media worker. Mount the contract artifact,
versioned release manifest and publishing-policy file using the paths in
`shorts.env.example`. Mount the dedicated operator key only in the separate
[publisher process](PUBLISHER.md). Both local demo flags must be `0`; hosted startup rejects them.

### Media release image

Build the ordinary API image first. For a Shorts release, apply the shared
media artifact built by `superhero-video-moderation/decoder/media.Dockerfile`:

```sh
docker build -f Dockerfile.media \
  --build-arg APPLICATION_IMAGE="$APPLICATION_IMAGE" \
  --build-arg MEDIA_RUNTIME_IMAGE="$MEDIA_RUNTIME_IMAGE" \
  -t superhero-api-shorts:release .
```

Both inputs are required. Use approved registry digests, or verified image
archives loaded into the local Docker engine. A separate BuildKit builder needs
access to the same inputs; a tag loaded into one Docker engine is not available
automatically to another builder. No registry publication happens in this command.

The release layer preserves the application, startup command and environment.
It checks the matching Alpine FFmpeg package ABI, replaces only the decoder
tools/libraries, verifies their recorded hashes and compares all media
capabilities. A changed ABI or capability fails the build. It does not upgrade
the application or silently fetch a replacement media dependency.

Deploy and test the resulting image for the API, publisher and media-worker
roles, keeping their existing dedicated configuration and permissions. Retain
both input identities, the final image digest/archive and its SBOM. Record the
downstream FFmpeg source component from `/usr/share/ffmpeg/source.json` in that
SBOM; the distribution package database alone cannot identify the replacement
binaries. Use the same qualified media artifact for the streaming service.

### Contract release identity

`SHORTS_DEPLOYMENT_FILE` must contain the following versioned public manifest.
Mount the same file read-only in the API, setup command and publisher. The node
origin comes from this file; the API no longer silently uses a hardcoded node.
The publisher's optional `SHORTS_PUBLISHER_NODE_URL` must match it exactly.
HTTPS is required in production. Plain HTTP loopback is accepted only outside
production for local tests. Configuration files must be absolute regular files,
not symlinks, and no larger than 1 MiB.

```json
{
  "schemaVersion": 2,
  "network": "ae_uat",
  "node": "https://testnet.aeternity.io",
  "middleware": "https://testnet.aeternity.io/mdw",
  "contract": "<verified ct_ address>",
  "previousContract": null,
  "operator": "<verified ak_ publisher address>",
  "treasury": "<verified ak_ treasury address>",
  "compiler": "8.0.0",
  "sourceHash": "<64 lowercase hex characters>",
  "bytecodeHash": "<64 lowercase hex characters>",
  "aciHash": "<64 lowercase hex characters>",
  "likeFeeAetto": "0",
  "treasuryBps": 2000
}
```

Replace the placeholders with the independently verified release values. The
source hash is SHA-256 of the source UTF-8 bytes. Bytecode hash is SHA-256 of the
**encoded `cb_...` string**, matching the contract build tool. ACI hash is SHA-256
of `JSON.stringify(artifact.aci)` encoded as UTF-8, preserving array and property
order. Whitespace in the enclosing artifact file does not affect it. All digests
use lowercase hex. `likeFeeAetto` is an exact integer string; `treasuryBps` uses
10,000 basis points. `previousContract` must match `get_previous`, including
`null` when there is no predecessor.

When `previousContract` is set, also include `previousArtifact` with the previous
contract's `compiler`, `sourceHash`, `bytecodeHash` and `aciHash`. These use the same
formats as the current artifact. Mount that artifact and its deployment receipt
using `SHORTS_PREVIOUS_CONTRACT_ARTIFACT` and `SHORTS_PREVIOUS_DEPLOYMENT_FILE`.
The receipt, artifact and deployed code must agree with the pinned predecessor.
Omit `previousArtifact` when `previousContract` is `null`.

The website independently pins the **normalized** manifest using
`VITE_SHORTS_RELEASE_HASH`. After building the API, calculate the public value
from the reviewed local file (with `SHORTS_DEPLOYMENT_FILE` already set):

```sh
node <<'NODE'
const { shortsConfigJson, shortsRelease, releaseHash } = require('./dist/shorts/shorts-release');
(async () => {
  const release = shortsRelease(await shortsConfigJson(process.env.SHORTS_DEPLOYMENT_FILE));
  console.log('VITE_SHORTS_RELEASE_HASH=' + releaseHash(JSON.stringify(release)));
})().catch(() => { console.error('Invalid release manifest'); process.exitCode = 1; });
NODE
```

This only reads public configuration; it does not connect to a node or sign. Copy
the value to the matching web build configuration and rebuild. Do not hash the
raw file: normalization removes receipt metadata and orders fields consistently.
The API exposes the same normalized identity in `/api/shorts/config` for comparison;
the browser never accepts an API-supplied hash as its trust source. Public browsing
can continue without a web pin, but wallet actions fail closed.

The free-Like release requires a deployment of the new contract and its matching
manifest. Editing an old paid-contract receipt cannot remove its charge.
The compiler/source declarations, actual artifact bytecode and ACI hashes must
agree with the manifest before node access.
Startup then checks the node network, deployed bytecode, operator, treasury,
fee/split and predecessor. The publisher repeats those chain checks before
preparing a signature. A mismatch fails closed.

The manifest is trusted deployment configuration, not a digital signature or
proof that an ABI was compiled from its declared source. Protect it through the
release process and read-only mounts. The current runtime still rejects mainnet
and non-default middleware. Sponsorship requires the verified nonpayable Like
entrypoint and a live zero Like fee. Changing a manifest alone cannot change
the deployed contract's behavior.

The public Shorts configuration derives its network and contract policy from
that validated manifest; there are no separate display-price defaults.
Free Likes create no rewards. Configuration requests reject a release change
during readiness checks. Clients independently verify the manifest before signing.

Mount this same complete versioned manifest for the media worker and operations
tools (reference, S3, HLS and IPFS inventories and storage reconciliation). They
use the shared release loader before accessing their service resources; shortened
receipts containing only a contract, network and source hash are rejected. These
roles validate the manifest locally and do not gain a signer or chain access.
The API and publisher additionally verify their artifact and live chain state.
Manifest files must be ordinary files at absolute paths, at most 1 MiB; symlinks,
directories and pipes are rejected. Keep manifests mounted read-only and restart
all roles together when changing the approved release.

The loopback demo alone opens a local SQLite snapshot and encryption key. Hosted
startup rejects a local data-directory setting or old import flags: finish the
[offline migration](LEGACY-STORAGE.md) before removing those settings. A shared
cutover record prevents startup after an incomplete legacy transfer.
On-chain history uses the shared MDW plugin pipeline and PostgreSQL. Hosted content
and wallet sessions, upload/preparation jobs, analytics/privacy and playback dispatch
also use PostgreSQL. [Transaction activity history](RECEIPTS.md) uses PostgreSQL
with an explicit import for existing local receipts. Private uploaded media uses
encrypted S3; hosted content without private shared references blocks startup.
Configure [shared request limits](RATE-LIMITS.md): hosted instances require the same
`SHORTS_RATE_KEY_FILE`, the normal Redis connection and explicit `TRUST_PROXY`
addresses/ranges (or no proxy trust for direct access). These guards protect all
Shorts HTTP routes before controller work and multipart allocation.
Apply all API migrations through `1791849600000-ProductionRuntimeSchema`. The trusted API role
needs SELECT on `shorts_legacy_cutovers`; only the offline migrator needs writes.
Do not grant these records to media-worker or publisher logins.
Run the normal API migrations before enabling Shorts. The Shorts migrations create
`shorts_chain_events` and `shorts_index_backfill`, then add durable block coverage,
shared content/preparation tables and scoped authentication tables.
Use a separate migration job and a restricted runtime account as described in the
[production deployment guide](../../README.md#-production-deployment). The shared
API's production token and DEX startup checks require the migrated schema but do
not require permission to create or alter it.
Existing installations replay their contract history once after the coverage migration;
earnings reports stay marked as catching up until this completes. Keep `DISABLE_MDW_SYNC=false`.

Remote services use HTTPS and separate credentials mounted as files:

```dotenv
SHORTS_IPFS_API=https://services.example.com:8443/api/v0
SHORTS_IPFS_TOKEN_FILE=/run/secrets/shorts-ipfs-write
SHORTS_MODERATION_URL=https://services.example.com/moderation
SHORTS_MODERATION_TOKEN_FILE=/run/secrets/shorts-moderation
SHORTS_STREAM_INTERNAL_URL=https://services.example.com
SHORTS_STREAM_KEY_FILE=/run/secrets/shorts-streaming
```

These keys belong only in server processes. The isolated media worker also needs
its own moderation credential, as described in [PRIVATE-STORAGE.md](PRIVATE-STORAGE.md).
The web app receives public API/playback URLs, never service credentials.
Point the streaming service's `STREAM_CATALOG_URL`
to this API's `/api/shorts` endpoint. Allow backend egress to the service server
and testnet node. Back up PostgreSQL, private S3, IPFS and the required secrets in independent storage.
The isolated publisher holds the operator key for testnet publication; viewer payments remain wallet-signed.
Configure normal ingress limits for uploads (40 MiB), API rate limits and HTTPS.

### Restarts and load limits

Keep a single hosted API deployment until shared ingress/admission limits and
measured capacity permit rollout across replicas. Shared repositories now remove
the local snapshot dependency, but this alone does not certify horizontal scale.
Graceful shutdown rejects unstarted operations and drains started work. Shared
leases, outboxes and transaction journals recover interrupted work.

The loopback demo requires stop-then-start deployment and an exclusive SQLite
owner. Its process crash releases the lock; a paused process keeps ownership.
Never replace a live database to force another process to start. Back it up
consistently with its local encryption key, separately from hosted storage.

`SHORTS_MAX_PENDING_OPERATIONS` caps active plus waiting API mutations
(default 8, range 1–64). `SHORTS_OPERATION_WAIT_MS` limits waiting time before work
starts (default 30000 ms, range 100–60000). Saturation, an expired queued request,
or shutdown returns HTTP 503. An expired request never starts later. Active writes
are not interrupted or automatically resubmitted by this deadline. These controls
bound the process queue; they do not replace ingress limits, upload concurrency
controls, the durable preparation queue or shared transactional storage for scaling.

Upload admission runs before multipart parsing on legacy uploads and chunk parts;
resumable finish shares the same request capacity. `SHORTS_CONCURRENT_UPLOADS`
defaults to 2 per API process (range 1–8). Hosted APIs also share
`SHORTS_SHARED_CONCURRENT_UPLOADS` through Redis (default 4, range 1–64), with at
most one active upload request per authenticated wallet across replicas. A wallet
already uploading receives 429; full or unavailable capacity returns 503. The
loopback demo retains its process-local capacity without requiring Redis.

`SHORTS_UPLOAD_BODY_TIMEOUT_MS` defaults to 120000 ms (range 1000–300000) and closes
unfinished multipart bodies, including trickling connections.
`SHORTS_UPLOAD_OPERATION_TIMEOUT_MS` bounds the whole upload request, including
private storage (default 180000 ms, range 1000–600000). Shared leases cover parsing,
S3 IO and settling metadata writes. Losing the lease, deadline expiry or shutdown
cancels further IO and parsing. Disconnecting after the body is received does not
free capacity while its handler still runs. A lost response can mean a part/job
was accepted: query the upload status and resume the same upload and part bytes.
Video preparation runs in the separate worker; these request limits do not cancel
already accepted background jobs. See [shared admission operations](RATE-LIMITS.md#upload-capacity).

### Resumable preparation

`POST /api/shorts/uploads/:id/finish` and the legacy multipart `POST /api/shorts/upload`
return HTTP **202** with an upload status, not a prepared video. Poll the authenticated
`GET /api/shorts/uploads/:id` using the returned ID:

| Status | Client action |
|---|---|
| `uploading` | Send missing parts sequentially, then finish |
| `queued`, `processing` | Poll status; do not create another upload or resubmit finish |
| `ready` | Use `video` from the response; publication remains a separate explicit request |
| `failed` | Show the safe error; the creator may deliberately retry finish |

Deploy the matching web client and API together while Shorts traffic is disabled;
older clients expecting a video directly from finish are incompatible with 202 jobs.
After a lost finish response, read the existing upload ID before deciding to retry.
Studio retains the upload ID by API, account, network and contract, retries temporary
status-read failures, and cancels browser polling on wallet changes. Reselect the
same file and metadata after a reload to continue the saved job.

In the hosted API, queue admission and frozen upload parts are stored in PostgreSQL;
private source and output bytes use encrypted S3 objects. An independent Nest worker
prepares each video and commits a private draft under a renewable fenced lease.
See [PRIVATE-STORAGE.md](PRIVATE-STORAGE.md) for configuration, cutover and worker
commands. New jobs and retries share bounded admission. Shutdown or a killed worker
leaves accepted work recoverable; a stale worker cannot replace the accepted output.
Prepared output is never approved or published by the worker.

The loopback-only demo keeps the SQLite queue and local encrypted files. Its single
background worker runs independently of the mutation queue. `SHORTS_INGEST_QUEUE_CAPACITY`
controls this local queue (default 8, range 1–32; two jobs per creator). The hosted
shared queue currently uses eight jobs/two per creator. Both paths keep three attempts
and return 503 when full. Local startup recovers interrupted processing; incomplete
local sessions expire after 24 hours. Shared accepted jobs survive session expiry;
shared metadata/object retention requires coordinated cleanup, not bucket-wide expiry.

`GET /api/shorts/operator/ingestion` requires operator authentication. Hosted responses
include shared queue counts, oldest queued age and recent worker count without creator
identifiers. The standalone demo reports its local worker state. Keep one hosted API
instance until distributed ingress limits and capacity testing support more, even
when scaling media workers.

Hosted publication/storage recovery uses [durable per-video jobs](LIFECYCLE.md).
It processes bounded batches, checks individual IPFS pins and reuses saved
publication requests after restarts. Operator queue health is available at
`GET /api/shorts/operator/lifecycle`. This repair path retains withdrawn media
pending a separate retention workflow; it does not run a destructive pin sweep.

### Upstream response limits

Storage and moderation clients bound decoded response bytes while reading, before
JSON parsing or integrity checks. They reject missing, oversized or malformed
evidence rather than accepting it as an approval. Cancellation covers body reads
as well as waiting for headers, and unread error/status bodies are discarded.

| Response | Maximum decoded size | Request deadline |
|---|---|---|
| IPFS media verification | Committed file size, at most 64 MiB | 5 seconds |
| IPFS add result | 16 KiB | 60 seconds |
| One IPFS pin check | 16 KiB | 10 seconds |
| Local demo pin inventory | 256 KiB and 4,096 entries | 10 seconds |
| Visual inspection evidence | 256 KiB | 150 seconds |
| Visual service health | 16 KiB | 3 seconds |
| Optional topic classification | 16 KiB | 8 seconds |
| API blockchain-node response | 5 MiB | 8 seconds |

Media still requires exact length and SHA-256 agreement with its manifest. A
compressed response is limited by its decoded bytes; a declared Content-Length
alone is insufficient. The hosted recovery path never reads the full pin inventory.
These bounds apply per request and supplement admission limits and process/container
memory budgets. They are not a throughput guarantee or a deadline for an entire
multi-request publication workflow. Streaming and publisher transports have their
own response and deadline rules.

The API node client admits at most 16 HTTP requests and 32 read operations per
process, returning 503 on overload. Contract/account reads have a 20-second total
deadline that also cancels their HTTP requests. SDK GET request sharing is disabled
so cancelling one caller does not cancel another. Redirects and automatic HTTP
retries are disabled; successful dry-run responses must contain exactly one result
per requested transaction. Request bodies are limited to 128 KiB.

The hosted API node transport permits reads and dry-runs, never transaction
broadcasts. The loopback demo explicitly enables submission; that option is
rejected in production. Read-operation deadlines must not wrap database writes or
transaction submission. The isolated publisher retains its own signing and
unknown-outcome recovery rules.

Shutdown cancels node, IPFS, private-media and inspection requests. Recovery workers
cancel their own node reads before waiting for imported modules to close. Started
mutations still drain; these network limits do not impose a deadline on every
database operation or prove a bound for whole-application shutdown. Keep deployment
shutdown grace periods and database timeouts consistent with active work.

The local demo lock uses SQLite's [exclusive locking mode](https://www.sqlite.org/pragma.html#pragma_locking_mode)
on the same connection that persists the state, holding ownership across commits.

## Shared metadata module

`ShortsMetadataModule` provides a PostgreSQL repository for content and preparation
jobs through Nest dependency injection. Its schema is managed by the API's normal
TypeORM migrations (`ShortsMetadata1791763200000`); it never creates tables during
an HTTP request or starts a decoder or wallet. The hosted module uses this repository
through `ShortsRecordsService` for uploads, content lists, publication, moderation,
reports, appeals, playback authorization and recovery. The standalone loopback demo
retains its local content registry. There is no fallback to a local snapshot when the
hosted database is unavailable.

**Keep one enabled API process** until distributed ingress limits and measured
capacity support more. Hosted state uses PostgreSQL/S3, and signing runs separately.
The [shared retained-upload budget](UPLOAD-BUDGET.md) defaults to 50 uploads and 50 × 40 MiB. Explicit setup can change it after measured capacity planning; retries reuse their reservations.

Hosted review decisions, reports and appeals use locked database updates directly;
they do not wait behind a slow rescan in the local snapshot queue. Compatibility
view reads also bypass that queue. Shared request admission, authentication,
operator checks and database workload limits still apply. Duplicate report IDs
count once; competing appeals return one acceptance and a 409 conflict. A later
moderation decision prevents an older scan from restoring approval. The local
demo retains its exclusive mutation queue. Hosted private previews, rescans and
IPFS recovery share a [media transfer limit](RATE-LIMITS.md#shared-media-transfers)
across API instances, in addition to the existing per-process scan queue. Busy
maintenance work waits without consuming failure retries. This does not authorize
additional API replicas.

`npm run test:shorts:hosted-actions` uses disposable loopback PostgreSQL and Redis
configured with `SHORTS_TEST_PG_URL` and `SHORTS_TEST_REDIS_URL`. It exercises two
HTTP runtimes, signed sessions, concurrent decisions, shared request limits and
reconnection. Scanner, chain and analytics responses are controlled fixtures;
deployment and full-pipeline validation are still required.

`npm run test:shorts:assembled` boots the complete enabled hosted feature in
separate processes with restricted PostgreSQL roles, shared Redis admission and
real private S3/IPFS transfers. Configure `SHORTS_TEST_PG_URL`,
`SHORTS_TEST_REDIS_URL`, `SHORTS_TEST_S3_ENDPOINT` and `SHORTS_TEST_KUBO_API` using
**disposable loopback services only**. S3 fixture credentials use
`SHORTS_TEST_S3_ACCESS_KEY` and `SHORTS_TEST_S3_SECRET_KEY` (default `test`). The
fixture requires FFmpeg, creates owned synthetic media and cleans its temporary
schemas, roles, objects and pin. Run it separately from tests that pause Redis.
It checks startup at the default and minimum SQL budgets, missing-migration
failure, signed sessions across processes, owner-only previews, shared media
admission, API process loss and a single durable publication request after retry.
It also sends ABI-encoded events through the production Shorts plugin, version
replay and closed-range backfill, then checks real PostgreSQL notifications,
WebSocket consumers, HTTP catalog/revenue reads, canonical rollback and withdrawal.
A terminated PostgreSQL listener reconnects without dropping its browser transport.
Content restrictions notify after commit; rolled-back and unchanged bodies do not.
Chain state, canonical middleware inputs, a reconciled publisher observation and
scanner verdicts are controlled fixtures. No real signer or remote MDW ingestion
is exercised; this is not a live-chain, model-accuracy, HLS, browser-wallet or
production load test.

For cross-service playback validation, build a local `superhero-video-streaming`
checkout first and set `SHORTS_TEST_STREAMING_REPO` to its absolute path when
running the assembled suite. The test starts the actual server and HLS worker,
connects the API publication outbox, kills a worker during its IPFS download and
waits for the normal BullMQ lease recovery. It decodes the resulting signed HLS
with FFmpeg and checks a cold origin restart without a worker or retranscoding.
Allow several minutes; the worker's 60-second lock is not shortened.

Optionally set `SHORTS_TEST_EDGE_IMAGE` to an already available NGINX image
matching the streaming edge Dockerfile. Docker access is required. The suite
creates one disposable, bounded, loopback-only edge with the checkout's NGINX
configuration, then checks cache hits, token enforcement and withdrawal/review
revocation. It uses a two-second catalog TTL for this test; the production default
remains 15 seconds. The edge cache quota is reduced for its disposable tmpfs.
No images are pulled. Test processes, containers, Redis namespace, scratch files
and owned HLS pin are cleaned; application data and services are not used.
Without these opt-in variables, the assembled suite only validates the API/index
portion. FFmpeg decoding is not a browser, mobile-device or real-wallet journey.

Run `npm run test:shorts:encoding` with FFmpeg/ffprobe installed to check the
actual upload decoder against generated boundary files: 4K/60 fps, 240 fps,
10-bit HEVC, odd dimensions, phone rotation, duration limits and corrupt or
truncated input. It checks the normalized output and temporary-file cleanup.
After `npm run build`, use `SHORTS_TEST_COMPILED=1 node --test
src/shorts/shorts-encoding.test.cjs` to exercise compiled services without a
TypeScript loader. Run that command in the intended worker image under its
resource quotas as well; a host run alone does not validate container capacity.
All clips are synthetic. This check does not load the complete worker, storage
clients or moderation models and does not establish worst-case upload capacity.

Set `SHORTS_TEST_UPLOAD_LOAD=1` to add four simultaneous authenticated uploads
across the two API instances. The independent moving synthetic MP4s cover
2.2/12/30/60 seconds, portrait/landscape and audio/silent inputs. Four real media
worker processes compete under the unchanged shared ceiling; one is stopped at
encoding, killed and recovered after the normal lease expires. The check covers
part/finish retries (up to three bounded retries for 429/503, with denials
reported), owner isolation, prepared-media decoding, source-byte budget accounting and rejection of publication while review is pending. Model decisions
remain fixtures; this does not establish moderation throughput or accuracy.

Allow up to seven minutes for this opt-in suite. For an isolated upload workload,
omit the browser and streaming options. `SHORTS_TEST_UPLOAD_LOAD_OUTPUT` may point
to an absolute private evidence path for aggregate workload observations. The
single-host synthetic mix and sampled SQL timings do not establish production
upload capacity, sustained memory usage, cost or a launch SLA.

To exercise actual models through durable uploads, supply a dedicated disposable
moderation service using `SHORTS_TEST_MODERATION_URL=http://127.0.0.1:<port>`,
`SHORTS_TEST_MODERATION_TOKEN_FILE=<absolute fixture credential path>` and
`SHORTS_TEST_MODERATION_DISPOSABLE=1`. Run the moderation repository's current
source with its pinned cached model image and normal resource limits. Use
`SHORTS_TEST_COMPILED=1` after building the API. Never point this test at a shared
or production scanner. No model downloads or service provisioning occur in the
API test itself.

This opt-in test delays the first inspection request until a second worker has
observed real readiness and committed its claim, then forwards both unchanged
requests to the scanner's single admission slot. The database's nonblocking
claim guard remains enabled. It checks the real 429 response refunds the deferred attempt,
stops both workers, and waits for normal lease recovery in a replacement worker.
Two generated uploads finish with actual model revisions/evidence, remain
owner-only and cannot publish without approval. Allow several minutes for the
120-second lease plus scanning. Other assembled-suite cases still use fixture
scanner decisions and controlled chain observations. This is not a classifier
accuracy evaluation, installed-wallet test or validation of deployed worker
container limits.

For the actual production entrypoint, run `npm run test:shorts:worker-container`
with a locally built API image and disposable Docker dependencies. The Dockerfile
compiles native modules in a build stage; the final non-root image contains FFmpeg,
production dependencies, compiled code, static assets and migration scripts, but
no Python/C++ build toolchain. Supply the private dependency token through the
existing BuildKit `GITHUB_TOKEN` secret, never a build argument or image environment.

The container test is opt-in and requires the following fixture configuration:

| Variable | Disposable fixture value |
|---|---|
| `SHORTS_TEST_WORKER_IMAGE` | Already-built image ID, `sha256:<64 hex characters>` |
| `SHORTS_TEST_WORKER_DISPOSABLE` | `1` |
| `SHORTS_TEST_WORKER_NETWORK` | An owned network named `shorts-worker-container-<8 hex characters>`, labelled `superhero.disposable-worker-test=true` |
| `SHORTS_TEST_PG_URL` | Loopback PostgreSQL admin URL; the same server is reachable as `database:5432` inside the network |
| `SHORTS_TEST_S3_ENDPOINT` | Loopback S3 URL; the same store is reachable at `https://private-s3:8443` inside the network |
| `SHORTS_TEST_S3_ACCESS_KEY`, `SHORTS_TEST_S3_SECRET_KEY` | Credentials for that disposable S3 store |
| `SHORTS_TEST_WORKER_CA_FILE` | Absolute path to the fixture CA certificate, trusted by both HTTPS fixture endpoints |
| `SHORTS_TEST_MODERATION_TOKEN_FILE` | Absolute path to the fixture scanner token; the real, ready scanner is reachable at `https://moderation:8443` |

The HTTPS fixtures must use certificates issued by the fixture CA, not the image's
default trust store. The test verifies both trusted and untrusted connections
before checking worker admission. Run the scanner with the moderation repository's
current source, pinned models and normal container quotas. The test does not
provision dependencies, pull images, download models or use a deployed service.
Docker, host FFmpeg and development dependencies are required by the test runner.

It starts `node dist/shorts/worker-main` with the real production configuration,
restricted SQL role, encrypted S3 objects and no Nest provider overrides. Worker
containers have two CPUs, 1 GiB memory with no additional swap, 96 tasks, a read-only
root and 512 MiB scratch tmpfs. Generated 4K/60 fps and 60-second sources exercise
scanning, encoding, SIGTERM and replacement recovery under the normal 120-second
lease. Results must remain private and unapproved. The test removes only its own
workers, secret volume, bucket, schema, role and temporary files; the fixture owner
must stop the dependency services afterwards. Allow seven minutes. This validates
worker isolation and recovery for synthetic inputs, not classifier accuracy,
worst-case public capacity, provider IAM or an HTTP/browser upload journey.

For a combined distinct-media journey, set `SHORTS_TEST_VARIED_HLS=1` with
`SHORTS_TEST_UPLOAD_LOAD=1`, `SHORTS_TEST_STREAMING_REPO` and `SHORTS_TEST_EDGE_IMAGE`.
The four uploaded clips receive explicit fixture approval, traverse real API
publication preparation/pinning and a single durable journal, then enter the
production plugin through controlled chain observations. The real HLS worker and
edge serve separate packages; FFmpeg decodes them and checks duration/audio.
Paced complete visits exercise cached delivery, and withdrawing one fixture
rejects its existing signed segment while the other videos still play. No signer,
real transaction or model verdict is involved. `SHORTS_TEST_VARIED_HLS_OUTPUT` may
point to an absolute private evidence path. This does not replace a browser/device,
deployed ingress, financial or production-capacity test.

For external resource observation, `SHORTS_TEST_EDGE_NAME` can assign the owned
disposable edge container a unique `sh-shorts-edge-<UUID>` name. Use a fresh UUID
for each run; the fixture removes that container on completion. This option is
only used by the integration test and never selects a deployed service.

Run `npm run build` first, then set `SHORTS_TEST_COMPILED=1` to load the API and
media-worker product modules from `dist` without a TypeScript loader in those
child processes. The parent integration harness still uses TypeScript. Each
child reports its module mode, and compiled children reject source-TypeScript
loads. Rebuild after any product-source change; this does not verify a deployed
image or its container limits.

With the upload workload, `SHORTS_TEST_UPLOAD_MODE=concurrent` starts the next media
worker once its peer has claimed work and reached encoding. This avoids a startup
claim-lock collision without pausing or killing an encoder; both processing slots
must be observed in use and every upload must finish in one attempt. The default
`recovery` mode retains the killed-worker scenario.
SQL lease overlap does not prove simultaneous encoders: observe native processes
when using either mode for resource measurements.

Set `SHORTS_TEST_CAPACITY=1` alongside the streaming and edge options to exercise
three new video IDs through real HLS preparation, paced full HTTP visits, a burst
that must receive 429 responses, and successful playback after the burst. It uses
the streaming checkout's configurable load probe and samples protected origin
queue/cache/RSS metrics. Limits and client identity are unchanged. Optionally set
`SHORTS_TEST_CAPACITY_OUTPUT` to an absolute private evidence path for the report.
These IDs share a small synthetic source: this is an admission/recovery baseline,
not upload throughput, independent viewer capacity, a decoded-playback benchmark
or production sizing. Leave browser integration disabled for an isolated workload;
a browser enabled in the same fixture can add playback traffic.

To include the web viewer and application routes, also set `SHORTS_TEST_WEB_REPO` to a local web
checkout with its dependencies and Playwright Chromium already installed. This
requires both streaming and edge options above. The suite starts an ephemeral
loopback Vite server and headless Chromium, then uses real HLS.js/MediaSource and
the edge for decoded playback, pause/dialog behavior, unmount cleanup and denied
playback/retry after withdrawal or restriction. It checks desktop and narrow
viewports; `SHORTS_TEST_BROWSER_OUTPUT` may name an absolute directory for optional
screenshots. The isolated player scenarios substitute identity/follow widgets.
A separate journey loads the actual `main.tsx`, app shell, route tree and Shorts
hooks without component substitutions. It uses the real hosted feed and state
endpoints, saves/unsaves a Short, reloads Saved, checks guest Following, opens
Studio and returns, and opens a shared link. Scoped live updates preserve a
paused player; a committed restriction removes it and releases its media source.
An explicit feed refresh discovers the restored candidate.

The connected Studio journey uses the real app wallet detector and SDK wallet RPC
with newly generated, disposable accounts. Creator-access messages are signed and
verified by the hosted API; wallet transaction signing and broadcasting are denied
by the fixture. It checks rejected access, session reuse across Studio routes and
reload, account-switch revocation, private-content isolation and delayed signatures
from a previous account. Chain reads and balances remain controlled observations.
This does not validate the installed wallet extension, deep-link popup, real
payments or physical-device behavior; those require separate acceptance testing.

That connected creator also uploads an owned synthetic video through the actual
three-step form. The server accepts a part and a finish request whose browser
responses are deliberately lost. Reselecting the same file and details after a
reload must reuse the upload, and reloading pending publication must reuse its
journal. The real private-storage/FFmpeg worker prepares the draft; publication
and public playback remain denied before approval. The harness supplies an
operator approval and a reconciled external publisher observation for this
synthetic video, then the actual plugin, HLS worker and edge complete playback.
These controlled approval/chain transitions do not validate moderation accuracy,
staffing or an installed-wallet/public-chain publication journey.

To include connected Following in that journey, set `SHORTS_TEST_SOCIAL_BUILD`
to the absolute path of the social contract's generated `build.json`. Its encoded
bytecode must match the API's checked-in social build hash. The harness applies
the existing social projection migration in its disposable schema and uses the
real projection writer, Following queries and social HTTP controller. Network and
bytecode identity verification remain enabled; external policy and relationship
reads are controlled observations. The browser checks follow/unfollow, blocks in
both directions, wallet account changes, unavailable-generation handling and HLS
playback after recovery. It first uses the visible feed refresh button, then
checks automatic updates through the existing social gateway and PostgreSQL
notifications sent by the other hosted API process. Unchanged updates preserve a
paused player; follow/block changes update the selection without clicking Refresh.
Terminating the database listener and closing the browser's global transport test
their separate reconnect/refetch paths. Foreign deployment notifications are
filtered. The fixture controls projected relationships and external chain reads;
it does not exercise social transaction signing or remote node event ingestion.

A second application journey uses 25 published catalog observations backed by
the owned video, with real per-ID HLS preparation. It crosses the API page boundary,
uses button and keyboard navigation, checks that only the current player runs,
and bounds mounted players and attached MediaSources while earlier players release
their sources. Live refresh and removal of an earlier candidate preserve a paused
player; restriction of the current clip releases it. Leaving for Studio releases
all MediaSources. These additional records are controlled publication observations,
not independent upload or signer executions. Controlled 429/503 responses on the
session, playlist, initialization segment and video segment must recover without
manual playback retry, respecting their Retry-After delay. Successful responses
still come from the real services. Other temporary admission failures are recorded;
the journey exercises the visible page retry control if needed.

The app journey proxies the disposable API through Vite at its configured web
origin, including the actual Shorts socket. Only the global SDK's public node
reads have controlled responses; unrelated remote requests are blocked. These
journeys use synthetic media and do not prove external wallets, production CSP
or a native device. Browser and Vite
processes are closed with the other owned fixtures.

### Moving existing content to PostgreSQL

Run the [offline legacy migration](LEGACY-STORAGE.md) with the old API stopped.
It transfers content, private files, accepted uploads, analytics/privacy and receipt
history with explicit checkpoints. Start hosted services only after it succeeds,
with no local data directory or startup-import flags. Restart reads shared state;
it never reloads the old snapshot or replays approval decisions. Keep the source
backup until recovery and retention requirements permit deleting it.

An imported record keeps its original review evidence; import does not grant approval.
Do not switch a migrated hosted deployment back to the local demo: the old snapshot
no longer contains current moderation decisions. Restore matched database/file backups
only during a controlled outage, with the hosted feature disabled until verified.

The repository scopes every read/write by network and contract, binds the source
hash and admission limits, and rejects inconsistent instance configuration. Records
have independent revisions. Use a locked synchronous `change` for metadata counters
and decisions, or `replace` with the expected revision for results calculated outside
the transaction. Scan responses also carry a generation: an older response cannot
replace a newer scan or review decision. Publication and serving re-read decisions
after network calls before continuing. Immutable media identity cannot change. Reads use cursor pagination
with a maximum of 100 records; this is a storage API, not permission to serve private
or unapproved records. Callers must enforce ownership and official content policy.

Preparation admission is idempotent by deployment and upload ID. Accepted input is
immutable, with global and creator limits checked under a shared database lock.
Workers claim jobs with `SKIP LOCKED`, a unique token and increasing fence, using the
database clock. Renew before the 1–300 second lease expires. Expired/replaced claims
cannot heartbeat, fail or commit. Completion saves the private unapproved draft and
ready status in one transaction. After an uncertain completion response, read job
status rather than creating another ID. Failed jobs require explicit retry, with at
most three attempts; queued work alone can be cancelled. An expired third attempt
becomes failed when a worker next checks the queue.

A job contains an opaque private object key and input hash, not a download URL or
video bytes. The API uses the metadata repository directly. The separate worker
uses the restricted database function and login enrollment documented in
[private storage](PRIVATE-STORAGE.md); it receives no application-table grants.
Never return job inputs, worker claim tokens or private object keys in public API
responses. The metadata module does not provide storage, validate a chain deployment,
perform moderation, sign transactions or enable mainnet.

To exercise the repository against an isolated local PostgreSQL database, set
`SHORTS_TEST_PG_URL` and run `npm run test:shorts:metadata`. The test uses its own
random schema and removes it afterward; it refuses non-loopback database URLs.

## Shared sign-in and revocation

Hosted wallet challenges and sessions use PostgreSQL via `ShortsSessionsService`.
They are scoped to the verified network/contract and configured `SHORTS_WEB_ORIGIN`.
All instances must use the same exact website origin. Signatures bind that origin,
network, contract, address, nonce and expiry. The server uses its database clock for
expiry; it stores random session tokens only as SHA-256 hashes. Missing database
access fails authentication; there is no SQLite or address-only fallback.

Challenges expire in five minutes and are consumed once, including an invalid
signature attempt. Shared admission permits at most three outstanding challenges
per wallet and 100 per deployment/origin. Signed sessions expire after 30 minutes,
with at most 30 per wallet and 3,000 per deployment/origin. Admission is serialized
in the database, so concurrent instances cannot exceed those bounds. Expired rows
are removed during challenge/issuance operations. These are interim capacity limits,
not a substitute for ingress rates, trusted-proxy configuration or public-launch sizing.

| Endpoint | Behavior |
|---|---|
| `POST /auth/challenge` | `{ address }` → `{ id, message, expiresAt }` |
| `POST /auth/verify` | `{ id, signature }` → `{ token, address, expiresAt, kind }` |
| `POST /auth/logout` | Bearer token; idempotently revokes that token, including an expired token |
| `POST /auth/logout-all` | Valid signed bearer token; revokes this wallet's sessions and pending challenges in this deployment/origin |

Revoking an account serializes with verification, so a signature already being
verified cannot leave a surviving session afterward. Already authorized in-flight
operations are not undone. Authentication is awaited before creator/operator routes
and before upload multipart allocation. The loopback demo keeps local sessions;
connection-only demo sessions cannot revoke signed sessions or gain operator access.

The web client clears browser credentials immediately on wallet/account changes and
session replacement, and sends a bounded, best-effort logout request to the matching
API. It also revokes a signed login response that arrives after the account changed.
It never forwards credentials from a different API environment. If the browser is
offline or closes before logout reaches the server, the token remains valid until
its server expiry; a failed background logout is not proof of server revocation.

Run all API migrations before enabling the hosted feature. **Existing local sessions
and challenges are not imported**: creators sign in again once after this upgrade.
Never copy local demo tokens into the shared tables. A rollback to local authentication
can revive an old token, so keep Shorts disabled while clearing old session/challenge
rows under a controlled rollback. Do not change origins or deployments to bypass
session scope checks. Verify with `npm run test:shorts:sessions` against a disposable
loopback `SHORTS_TEST_PG_URL`; it uses a temporary schema and real wallet signatures.

## Run locally

Requires Node 22.13+, FFmpeg/FFprobe on PATH, Docker, and the sibling `superhero-shorts-contract`, `superhero-ipfs` and `superhero-video-moderation` repositories. Compile/deploy that repository with its documented disposable testnet accounts first.

1. Install this API's normal dependencies (`npm ci` in an independent checkout).
2. Copy `src/shorts/shorts.env.example` to `.env.shorts-testnet`. Set absolute external paths to the operator-only key, deployment receipt and compiled contract artifact. Never supply creator or viewer private keys to the API.
3. Run `make start` inside `superhero-ipfs` for one offline Kubo node. For authenticated remote storage, use that repository's `make setup` and deployment guide: set `SHORTS_IPFS_API` to its HTTPS `/api/v0` URL and `SHORTS_IPFS_TOKEN_FILE` to the absolute path of its mounted 64-hex-character key. No endpoint list or credential-mapping JSON is needed. Remote plaintext URLs, missing credentials and redirects are rejected; keys stay server-side and are reloaded per request for rotation. This does not remove this bootstrap's local/testnet restrictions. Follow `superhero-video-moderation/README.md` to create a private service token and run `docker compose up --build -d` there. Set `SHORTS_MODERATION_URL` and `SHORTS_MODERATION_TOKEN_FILE` in the API environment.
4. Run `npm run start:shorts:testnet`.
5. In the web checkout, run `npm run start:shorts:testnet` and open `http://127.0.0.1:5180/shorts`.

API: `http://127.0.0.1:3334/api/shorts/config`. OpenAPI route listing: `/api/docs`. IPFS RPC: loopback 35002; debug gateway: loopback 38081. Visual inference: loopback 3340. All services bind to loopback. The normal API mounts this module only when `ENABLE_SHORTS=true`.

## Storage configuration migration

Replace `SHORTS_IPFS_APIS` with `SHORTS_IPFS_API` using the retained storage endpoint. Replace `SHORTS_IPFS_CREDENTIALS_FILE` with `SHORTS_IPFS_TOKEN_FILE` pointing directly to that endpoint's existing key. Remove the old variables; startup rejects them to prevent silently switching storage or disabling authentication. Local development may omit the key only for a loopback HTTP/HTTPS endpoint outside production. For a private CA, set `NODE_EXTRA_CA_CERTS` before starting Node.

Keep the original storage volume and verify its pin inventory before stopping any old replica. The IPFS repository documents this migration. A second copy, if introduced later, must be managed by the storage infrastructure behind the same API endpoint.

## Consumer and creator workflow

Watch without a wallet. Connect a wallet configured for æternity testnet and sign the one-time sign-in challenge to upload or open private creator information. Reporting needs no wallet. Use the official testnet faucet to fund your own test wallet. Signing in does not transfer tokens.

Upload an owned MP4/MOV clip (2–60 seconds, 40 MiB input maximum), title, topic, language, optional description/WebVTT captions, disclosures and rights confirmation. The web client sends resumable 1 MiB parts with an authenticated, 24-hour upload session. Both multipart upload routes authenticate before reading file bodies. Parts are encrypted, and the full SHA-256 is checked before preparation. Hosted uploads use private S3 and a separate media worker; the standalone local demo uses its encrypted local adapter. Reselect the same file and details to resume. Completing a session is idempotent. The preparation worker rejects decoding errors, limits decoder/filter/encoder threads independently, and produces a single 540×960 MP4, poster and manifest, and measures the exact package bytes. Drafts remain private until review approval and an explicit Publish request. Pending, failed, blocked and rejected decisions deny publication and official playback as well as discovery.

The standalone local adapter shares a persistent rolling-hour budget across its multipart and resumable uploads:
10 attempts / 400 MiB per creator and 100 attempts / 4000 MiB across the instance.
Session creation reserves the declared input bytes; its first preparation uses that
reservation. Failed uploads still count, and preparation retries or sessions older than
an hour use a new attempt. Limits are checked before writing originals or preparing
videos and return HTTP 429 when exhausted. Failed preparation removes encrypted
originals and partial packages; resumable parts remain available until their session
expires. Startup removes orphan prepared files while preserving registered media and
resumable parts. These instance limits supplement normal ingress rate limits. Hosted uploads use shared PostgreSQL admission budgets; private S3 cleanup and retention follow [the shared-storage guide](PRIVATE-STORAGE.md), not the local adapter’s file cleanup.

Operator review can use the web Moderation tab when signed in with the operator wallet. On the local machine, the operator-only console provides the same authenticated review actions:

```sh
npm run shorts:review -- list
npm run shorts:review -- approve <short-id>
npm run shorts:review -- restrict <short-id>
```

The upload flow is Video → Details → Review → Publish. `POST /api/shorts/:id/publish` checks the creator session and content approval, then persists publication intent. Hosted requests return `202` with `publicationRequest=preparing` without waiting for IPFS or node IO. The existing lifecycle worker pins and verifies the complete package through the single IPFS endpoint under a renewable database claim, then queues the separate publisher to call the operator-only `publish` contract entrypoint. Storage interruptions retry from saved intent; repeated requests do not reset recovery backoff or submit another signature. The loopback demo retains inline publication. Superhero pays storage and registration gas. The creator pays nothing and receives no publication wallet transaction. There are no hosting quotes, budgets, periods, top-ups, expiry dates or reward allocations. Retries are idempotent; the worker resumes saved publication intent after interruption only while content remains approved. A rescan clears prior approval before inspection begins; even a clear new result needs review again. Explicit local demo approval remains reversible and cannot override a blocked scan or rejection; hosted startup rejects demo bypasses.

IPFS write refusals with HTTP 429 or 503 leave lifecycle work in `capacity_wait`. The saved publication intent is retried after capacity becomes available without consuming failure attempts or marking the package pinned. Credential failures and integrity mismatches remain failures. Check storage admission separately from liveness: an IPFS node can serve existing videos while refusing new writes.

Each Like is a wallet-signed, nonpayable `like(id, expected_config_version)` call with zero amount. Superhero initially sponsors its network fee through a dedicated fee-payer process. Sponsored Likes require an authenticated API session and a wallet supporting inner-transaction signing; unavailable sponsorship does not silently charge the viewer. Likes create no creator or treasury reward. Claims only transfer previously accrued rewards. A withdrawal requires explicit confirmation, stops official playback permanently and cannot erase third-party copies. See [Like sponsorship](LIKE-SPONSORSHIP.md) for setup and recovery.

The read-only [wallet transaction endpoint](WALLET-TRANSACTIONS.md) distinguishes
mempool, mined, confirmed, failed, unknown and reorged observations for a saved
transaction hash. It requires no extra signing challenge and cannot submit a payment.

## Trust and persistence

- API signing authority is restricted to publishing verified storage packages. User payments, reward claims and withdrawals require the user's wallet.
- Startup verifies `ae_uat`, the configured operator, contract address and bytecode fingerprint.
- Wallet sessions use random, single-use five-minute signature challenges and 30-minute bearer tokens. Only token hashes are stored. Hosted sessions and content survive restart in PostgreSQL; the standalone loopback demo uses SQLite WAL.
- The worker retries pending publications every minute and at startup. Only an explicit publish request or a previously registered video creates that intent; private drafts never publish automatically.
- Existing registered videos migrate from a verified previous contract without expiry. Previously withdrawn videos remain withdrawn. Old rewards stay claimable on the previous contract and are exposed separately; old hosting funds are left untouched in that immutable contract.
- Hosted private source/prepared media uses AES-256-GCM with the configured S3 encryption key ring; the loopback demo and offline legacy backups retain their local key. Approved published IPFS packages are plaintext for public free viewing. Losing the relevant encryption key makes retained private files unrecoverable.
- One offline Kubo node pins public packages. Playback verifies the returned bytes; the worker restores missing published pins from retained encrypted packages. Replication is not an API responsibility. The contract/CID and test transactions are public on testnet; the videos are not broadcast to the public IPFS swarm by this setup.
- Publication verifies full package hashes; the separate streaming worker creates and pins HLS segments from the trusted IPFS source. Publication enqueues preparation through a durable outbox, which drops revoked jobs. Approved published videos remain available without a hosting deadline. Shared metadata, playback descriptors and analytics admission check current safety and canonical publication; denied items return 404 without public media metadata. The streaming service applies this permission to posters, captions, HLS and cache-hit authorization with a bounded status lifetime. Authenticated creator/operator preview remains available for review and appeals. Hosted recovery retains denied and withdrawn packages pending a reference-aware retention workflow, and never repairs or republishes denied content. Uncertain publication outcomes use the existing journal rather than a replacement signature. The local reconciler preserves shared CIDs and uncertain submissions before unpinning. Unpinning cannot erase cached/third-party copies or encrypted local source files.

`GET /api/shorts/health/playback` returns a small versioned readiness response only
when the API can read contract configuration and reach storage. It exposes no keys,
addresses or internal failure details. Deploy this API endpoint before the streaming
version that checks it. Streaming readiness also checks its own storage credential
and worker presence; synthetic upload/playback checks are still needed to prove the
complete processing path.

### Runtime data scope

Sessions, shared content, uploads, private media, analytics, receipt history and
background jobs use the verified release's network and contract. Feed/Studio cursors,
playback evidence and Redis admission keys use that same identity. A process fixes
this scope on first use; changing the release or contract requires restarting it.
Mismatched or uninitialized identity returns an unavailable error before scoped reads.
Existing scoped testnet SQL data and Redis key names are unchanged. The shared
chain index separately requires the ownership migration described below.

Local demo bearer-token hashes now include the network, contract and website origin.
Previously issued local demo sessions need to reconnect/sign in once. Hosted session
hashes and response formats are unchanged. An origin or deployment cannot consume
another scope's local sign-in challenge. Local SQLite remains a single-deployment
adapter; hosted services use the shared PostgreSQL repositories.

The shared chain index database remains dedicated to one network. These data adapters
can distinguish network identities, but the full application, worker and publisher
still enforce their explicit testnet startup guards.

### Dedicated chain-index network

Apply `1791763228000-ShortsIndexNetwork` through the normal API migration command
before enabling Shorts. The normal Shorts Nest module binds the shared index to its
reviewed release network at startup; it has no switch or API to change that binding.
Use a separate database for another network, including testnet versus mainnet.

For first adoption, stop older indexer instances during the upgrade and start the
updated indexer before read-only API instances. Its database role needs `SELECT`,
`INSERT` and `UPDATE` on `shorts_index_network` (`UPDATE` permits the startup lock;
the immutability trigger still rejects updates), and its existing write rights on
`key_blocks`/`txs` to acquire startup table locks. Subsequent read-only API startup
only needs `SELECT` on the binding. Use the ordinary database owner/indexer role to
perform this initial startup; do not grant publisher or worker roles this authority.

An empty index is bound after node-network verification. Existing history must have
valid stored positive-height key blocks: the earliest and latest are checked against
the configured node before binding, while history writes are locked. Missing,
mismatched or unavailable proof fails startup without changing records or saving a
binding; correct the endpoint or restore/rebuild the dedicated index and retry.
Endpoint checks establish network identity, not a complete audit of every stored
transaction. Normal replay, reorg and accounting checks remain necessary.

The binding is immutable across contract upgrades and process restarts. Database
triggers reject update, deletion and truncation; migration rollback refuses to drop
a bound identity. Backup/restore must include this table alongside chain history.
Do not remove the binding to repurpose an index. No existing content or earnings are
rewritten by adoption. Explicit mainnet startup guards remain in place.

### Signature network binding

Wallet transaction observations verify signatures in the release's network domain
for Like, withdrawal and current/previous-contract claims, supporting both SDK hash
signatures and legacy raw-byte signatures. The observer checks the live node network
before and after reading; a changed release, selected node or predecessor invalidates
the result, including pending and unknown transactions. It never submits transactions.

Publication validation requires the deployment network explicitly when persisting or
recovering signed bytes. There is no implicit network default. The journal and isolated
publisher still require the reviewed testnet configuration; network-domain validation
alone does not authorize mainnet startup or publication.

### Shared indexer release binding

The Shorts plugin uses the existing middleware sync loop, retry queue and reorg
handling. Its Nest provider requires `AE_NETWORK_ID`, `mdw.middlewareUrl`, the
shared SDK node and Shorts node to agree with the reviewed release manifest.
Changing only `SHORTS_DEPLOYMENT_FILE` cannot redirect the plugin away from the
shared indexer. Each API database remains dedicated to its configured network;
do not reuse an existing index database for another chain.

At startup and during indexing, the provider checks the live node network and
compares a closed key-block hash from middleware with the same height on that
node. Concurrent checks share work. Successful checks are retained for at most
five seconds on a monotonic clock; configured endpoint changes are rejected even
during that interval. Disagreement, missing checkpoints or provider failure leave
processing retryable rather than marking a projection or coverage range complete.
This confirms endpoint agreement; it is not an independent consensus proof of all
middleware data. The existing event decoding and node generation checks still apply.

Backfill uses only the pinned middleware origin/path, rejects redirects and
ambiguous range parameters, limits each decoded response to 1 MiB and URLs to
8 KiB, and admits at most eight concurrent reads. HTTP reads time out after ten
seconds; a full network check has a twenty-second limit. Shutdown cancels active
reads. These checks are read-only and hold no signing key. `shorts-updated` messages
use the initialized release network and contract. Mainnet startup remains disabled
until the other network, contract and release gates are implemented and approved.

## Tests

The standalone contract repository contains local-chain accounting/authorization tests. This API contains an opt-in testnet suite. It uses externally supplied disposable accounts and an owned video; it writes actual testnet transactions and leaves sample records in the local API.

```sh
SHORTS_TESTNET_E2E=1 \
SHORTS_TEST_KEYS_FILE=/absolute/private/shorts/test-accounts.json \
SHORTS_TEST_VIDEO=/absolute/path/owned-sample.mp4 \
npm run test:shorts:testnet
```

The operator in the supplied test accounts must match the configured contract. Run full API lint with `npm run lint` and typecheck with `npx tsc --noEmit`.

## MVP boundaries

The hosted API stores content, upload sessions, measurements, authentication and transaction activity in PostgreSQL, with encrypted private media in S3-compatible storage. It does not read the loopback demo's SQLite database. Keep one API instance until deployment/load validation permits expansion. Hosted ingress uses the shared [retained-upload budget](UPLOAD-BUDGET.md); physical provider/disk quotas remain independently required. Upload parts and worker media still use bounded buffers. A single IPFS node remains an availability dependency; persistent-volume backups are required and no provider SLA is implied. Reconciliation trusts the operator's retrieval attestation; it is not a decentralized proof of storage.

Topic suggestions can use the optional JEV adapter below. Operators review and correct the discovery topic separately from immutable package metadata; decisions and appeals use shared content history in the hosted API and local history in the standalone demo. Sampled visual screening is implemented below; representative safety evaluation, audio checks, age/territory controls and fraud-resistant analytics remain release work. Playback metrics are client reports from browsers, not verified people. Official moderation cannot prevent direct contract transactions or erase public chain/IPFS records. Wallet/store policy approval, production security and contract audit remain separate release work.


## Studio and analytics

`POST /:id/playback` requires a short-lived `proof` from the streaming service's
`GET /videos/:id/measurement` endpoint, in addition to `id`, `session`, `seconds`
and `source`. The player obtains a measured session by passing the SHA-256 hash
of its browser session in `X-Playback-Viewer`, then obtains the receipt using
`X-Playback-Token`. The API verifies the receipt with `SHORTS_STREAM_KEY_FILE`
(the streaming service's internal key). Invalid, expired, differently scoped or
different-browser receipts return 401 without recording a play; missing verifier
configuration returns 503. Unsigned legacy events never qualify.

Receipts bind the network, contract, Short ID, source CID, salted viewer digest,
session timestamps and authorized segment duration. Reported seconds are capped
by this duration and elapsed time before the existing browser/day and privacy
checks. Receipts and playback tokens are not stored in analytics. Deploy the
matching API, streaming service and player together; synchronize clocks and
restart both services together when rotating the shared internal key. This
correlates metrics with authorized segment requests, not completed delivery or
proof of a person watching. Browser reach remains an estimate; bot/Sybil defenses
are still required, and these metrics never determine rewards.

Creator routes live under `/shorts/studio` with content, analytics, revenue, upload and per-video pages. `/performance?days=7|28|90&short=<optional-id>` requires a creator session and checks video ownership. Live reward balances are always separate from the selected reporting window. Every playback summary (current, previous, daily and per-video) exposes `views`, `watchSeconds`, `watchHours`, `averageSeconds` and `completion`. `watchHours = watchSeconds / 3600` is returned without presentation rounding. Only qualified views contribute watch time; repeated segments are excluded, capped at one clip duration per browser/Short/UTC day. These are reporting-window totals, with up to 90 days of retained measurements.

Playback is counted automatically without an opt-in control, including for guests. Playback sends cumulative unique playback time after at least two seconds. Authenticated observations below that threshold do not allocate persistent viewer or playback records. The signed streaming-session timestamp anchors the first qualifying update, clipped to the current UTC day. The browser merges watched intervals and excludes repeated segments, seeks, paused, buffered and background playback; the server bounds reports by clip duration, authorized segment delivery and elapsed server time. The hosted API stores a salted browser identifier in PostgreSQL, never a wallet address, for up to 90 days. The loopback demo uses SQLite. A view requires two seconds; repeated loops are capped at clip duration and deduplicated per browser/Short/UTC day. Reach is distinct browsers within the requested creator scope. Source breakdowns need five browsers. Reports mark partial collection windows, including prior periods beyond retention, and never invent historical watch time. `/analytics/forget` removes the current browser's retained measurements and subtracts their qualified views. A salted revocation digest expires after 24 hours to reject late requests from that deleted session. Public `views` and Studio reports use the same qualified events. Anonymous lifetime view totals survive the 90-day expiry of browser records; only retained records can be removed by browser deletion. Existing qualified analytics rows migrate once, while legacy unmeasured preview views are excluded. The legacy `/:id/view` endpoint now only reads counters. These controls do not provide Sybil resistance.

For You receives a bounded engagement score from the last seven days: 70% watched fraction and 30% completion, averaged per browser before aggregation. Scores stay neutral below five distinct browsers and use twenty neutral prior browsers to temper small samples. The web client combines this with interests, follows, freshness and creator diversity. Recent stays chronological. Likes, rewards and wallet balances never influence engagement scoring.

Hosted on-chain history is indexed by `src/plugins/shorts`, registered alongside the
existing plugins only when `ENABLE_SHORTS=true`. Shared MDW backfill/live/reconnect
and reorg handling deliver transactions to its processor. Successful events are
projected atomically into `shorts_chain_events`, keyed by contract/transaction/log
index, with a foreign key to `txs`. Duplicate deliveries replace the same rows;
canonical transaction deletion removes their accounting rows. Decode failures go
through the shared failed-transaction mechanism. The plugin version sweep replays
the projection, not just decoded JSON.

The shared MDW sync tick calls the plugin's optional `catchUpToHeight` hook to recover
contract calls missed before enablement, during downtime or after websocket loss.
Each contract stores a contiguous `covered_height` plus a fixed range and page cursor
for unfinished work. A tick handles up to ten pages per contract; only a fully committed
range advances coverage. The current generation stays open until the next block.
Failures and restarts resume the saved range, even when global backward sync is already
complete. Normal low-latency updates still use the shared MDW stream. `txs.data.shorts`
records the projection version without overwriting another plugin's namespace.
Direct calls and events emitted through another contract use the same processor.

Revenue aggregates run in PostgreSQL over the complete history, with three
confirmations derived from the shared indexer's current tip. Reports expose stale
state while any contract's coverage is behind the latest closed generation, when plugin
jobs fail, or when the indexer heartbeat is old. Activity responses contain at most 200 recent receipts; daily revenue series
and totals are computed independently of that display limit. PostgreSQL
LISTEN/NOTIFY broadcasts `shorts-updated` after commit through the dedicated
`/shorts` Socket.IO namespace at transport path `/shorts/socket.io/`. Reconnect
and reorg also invalidate the web view. Apply migration
`1791763226000-ShortsContentUpdates` through the normal API migration command:
content creation, publication, review and removal then notify the same channel
in their database transaction, including changes made by workers or another API.
Rolled-back changes and unchanged content bodies do not notify. Notifications
contain only deployment identity; clients refetch authorized current state and
never receive private drafts or review data over this public socket.
This transport has shared Redis admission
and does not share sockets with token or social updates. Configure the reverse
proxy to forward WebSocket upgrades on this path; see [request and connection
limits](RATE-LIMITS.md). Balances and playback
withdrawal checks remain direct contract reads.

The standalone loopback demo keeps its bounded SQLite ledger in
`local-ledger.service.ts`; it is not loaded by hosted APIs. Run the isolated
PostgreSQL integration suite against a disposable local database:

```sh
SHORTS_TEST_PG_URL=postgres://postgres@127.0.0.1:55439/postgres npm run test:shorts:index
```

The suite creates and removes a unique schema. It covers duplicate delivery,
rollback, previous-contract earnings, reorg deletion, version replay, interrupted
backfill and aggregate totals beyond the old history limit.


Anonymous reports use bounded reason/detail fields and idempotency IDs. Creator-only appeals and operator-only review decisions are stored locally. Broader abuse prevention, policy staffing and legally complete notice/appeal workflows need production design.

## Optional TypeSafe JEV

Leave `SHORTS_JEV_ENABLED=0` until configured. Enable only with a server-side `TYPESAFE_API_KEY` and a pinned `SHORTS_JEV_MODEL=jev-x.y.z`. The adapter sends title, declared topic, description and optional creator captions to `https://api.typesafe.ai/v1/systemone`. It checks the returned version, taxonomy, confidence and output shape; uncertain or failed results fall back to manual review. Evidence hashes, taxonomy and rubric versions are retained. No viewing history or wallet data is sent. There is no raw video/audio analysis, ASR/OCR pipeline or automatic safety approval. Operators choose the final discovery topic; client matching uses that topic and local preferences.

Run `npm run test:shorts:unit` for offline analytics, privacy, JEV fallback, ownership, appeals, indexer and resumable-upload tests. The historical paid-Like testnet suite does not qualify the zero-payment contract. The offline sponsorship checks validate signed envelopes, fee caps, canonical observation and recovery without sending transactions. Live integration of the new contract and fee-payer process is a separate release check.

## Local Studio connection without an extra signature

Set `SHORTS_DEMO_CONNECTED_WALLET=1` in the ignored local environment and restart the API to use the main app's connected address throughout Studio. The config endpoint reports `creatorAccess: "connected-wallet"`; the web client opens and renews its Studio session automatically through `POST /api/shorts/auth/connect`. Switching or disconnecting the main wallet clears the previous account's creator data. Claims and withdrawals still require wallet-signed contract calls. Sponsored Likes require cryptographic authentication and are unavailable with this connection-only demo shortcut.

This is a local demo identity shortcut, not cryptographic proof of address ownership. A local caller can request a creator session for any valid address, including access to that address's drafts and analytics. It is disabled by default, requires local testnet mode and is unavailable in production. Hosted startup rejects this shortcut. Connection-only sessions expire after 30 minutes, are stored separately, cannot access operator review routes and stop working when the flag is disabled. Outside this mode, private creator access still uses signed sessions.

## Temporary local demo approval

Set `SHORTS_DEMO_AUTO_APPROVE=1` in the ignored `.env.shorts-testnet` and restart the local API to skip visual scans, scan retries and optional text classification. This opt-in mode requires `SHORTS_TESTNET_MVP=1` and is disabled in production. The config endpoint reports `moderationMode: "demo"` and `visualModeration: false`.

New uploads and existing pending videos become eligible for the feed immediately. Publication is still required for playback and feed inclusion; withdrawn and private draft videos remain unavailable. Previously blocked or explicitly rejected videos remain excluded. Wallet authorization, media validation, encryption, IPFS verification and payment checks are unchanged.

Approval is an effective demo policy, not a stored review decision: creator responses report `moderation: "approved"` and `guidelines.approval: "demo"`, without manufacturing scan evidence or overwriting review history. The web UI omits the community-guidelines check panel for these responses. Set the flag back to `0` and restart to restore the original review state; uploads created during the demo then need inspection and approval. The worker resumes scanning missing or failed evidence automatically.

## Local visual inspection (default mode)

Every upload sends the actual original bytes to the local Docker visual service before review. It samples two frames per second, scene changes and a final frame; Falconsai NSFW screens sexual/nudity content and OpenAI CLIP suggests visual topics. JEV is not involved in this visual pipeline and may remain disabled. The receipt binds model/policy versions, timestamps, image scores and topic suggestions to the original SHA-256. The API rejects malformed evidence, incomplete temporal coverage and inconsistent decisions.

Missing, failed or blocked scans deny publication, pin repair, direct-link playback and feed inclusion. Clear or explicitly reviewed borderline evidence still requires an approval decision; processing alone never approves a hosted video. A gray-zone score additionally requires an explicit full-video review checkbox and reason; the decision binds to that exact evidence hash. The operator and creator can request another scan from Studio. Existing records without receipts are scanned by the recovery worker; failed scans retry after at least a minute. Starting a re-scan clears prior approval and stops official delivery and discovery until reviewed again. It does not erase on-chain publication, existing storage or third-party copies. Creator responses contain a community-guidelines summary; technical frames, scores, review history and model/classification evidence are returned only by authenticated operator routes.

Sampled frames can miss brief content, and model scores have false positives/negatives. Initial thresholds require representative evaluation; this does not certify a pornography-free service or detect every illegal category. The model service has no signing, publication or IPFS authority.

## Upgrading the loopback demo contract

The following contract migration applies only to the standalone loopback demo.
Moving its existing deployment into the hosted API uses the separate
[offline storage migration](LEGACY-STORAGE.md); that command does not change
contracts or publish content.

Back up the SQLite database, previous artifact and deployment receipt before switching. Deploy the contract with `SHORTS_PREVIOUS_CONTRACT` set to the previous address. Point `SHORTS_DEPLOYMENT_FILE` and `SHORTS_CONTRACT_ARTIFACT` to the new deployment/artifact, and supply `SHORTS_PREVIOUS_DEPLOYMENT_FILE` plus `SHORTS_PREVIOUS_CONTRACT_ARTIFACT` for the verified old deployment. These paths and private keys stay outside Git.

Startup verifies both contracts, imports only records already registered on the old contract, and queues operator-funded publication. A stored registry for an unrelated contract is rejected. Prior Like counts and duplicate-Like protection carry forward. The event index reads verified Like/claim events from both contracts; Studio shows the earlier claimable balance separately. No hosting funds or rewards are moved by migration.

## Separate public playback

Public media is delivered by `superhero-video-streaming`, not this API. Start that repository with `make start`. Feed/Studio records return IDs, metadata and a `captions` boolean; they no longer return API media URLs. `GET /api/shorts/playback/:id` returns only the published CID and allowlisted file names/sizes/hashes. It checks the current on-chain owner, CID, byte count and withdrawal state, and never exposes a draft. Both feed discovery and direct-link playback require current content approval; publication alone never bypasses screening or a restriction. The old `/media/:id/:file` route returns 410. Private authenticated review previews and upload-time full-file IPFS verification remain in this module. Testnet lifecycle tests use `SHORTS_STREAM_URL` (default `http://127.0.0.1:3335`) for playback. The service provides expiring HLS playlists and segments; its former full-MP4 route returns 410. It prepares existing videos without changing their contract CID. Original and prepared HLS packages are pinned in IPFS. Playback caches are disposable; eviction does not require transcoding again. Configure SHORTS_STREAM_INTERNAL_URL and SHORTS_STREAM_KEY_FILE for the private authenticated preparation endpoint. The hosted [PostgreSQL publication outbox](STREAMING-OUTBOX.md) commits preparation jobs with content publication, retries failed delivery and recovers expired dispatcher claims. The migration seeds existing published records; the local demo retains its SQLite outbox. The streaming service caches publication descriptors for a fixed 15 seconds by default; withdrawal can take that long to reach playback, including edge cache hits. SHORTS_STREAM_URL remains the test client’s public playback URL.

## Isolated hosted publication

Hosted API instances no longer accept `SHORTS_OPERATOR_KEY_FILE`. Run the separate
NestJS publication worker using the same API image and a dedicated database login.
See [PUBLISHER.md](PUBLISHER.md) for setup, spending limits, key mounts, progress
responses and recovery. The loopback local demo retains its inline testnet signer.

## Catalog pagination

`GET /shorts/feed` and authenticated `GET /shorts/content` return bounded cursor pages.
See [CATALOG.md](./CATALOG.md) for ordering, policy checks, migration and client usage.
The original feed and dashboard remain compatible and capped until their consumers
and aggregate reads migrate; these endpoints do not raise upload capacity.


Hosted Studio advertises `studioPaging` and uses authenticated summary, content-page
and individual-video reads over the existing plugin projection. Apply the Studio
lookup-index migration with the other migrations. See [catalog reads](CATALOG.md#creator-studio-read-model)
for query parameters, freshness and deployment behavior. These endpoints do not
remove the upload admission cap or the remaining single-instance API constraint.

`npm run test:shorts:shared-runtime` checks hosted startup without local storage.
Set `SHORTS_TEST_PG_URL` to an isolated loopback PostgreSQL database to also test
concurrent API contexts and incomplete-cutover refusal. It creates and removes its
own schema; do not use an application database.

### Shared media processing capacity

Apply migration `1791763215000` before starting the current media worker. It limits
active preparation leases across all workers in one network/contract, default two.
Adding worker replicas does not raise that ceiling. Workers check the database
guard at startup and cancel processing if lease renewal stalls. See
[private storage and worker operations](PRIVATE-STORAGE.md) for controlled changes,
rollout/rollback and the separate infrastructure and HTTP-ingress limits.

[IPFS pin and capacity inventory](PIN-INVENTORY.md) records physical pin observations
and compares them with original/HLS references using a separate read-only storage key.

Current free-contract account responses use zero current rewards without calling removed accounting getters. Verified earlier reward contracts remain separate and keep their existing claim paths. Historical withdrawal markers continue to govern playback and migration; the current contract does not expose withdrawal.

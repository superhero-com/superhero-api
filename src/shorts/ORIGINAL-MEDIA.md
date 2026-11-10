# Original-file Shorts media

The server-assigned `original-h264-v1` processing profile preserves the uploaded
file byte-for-byte. `ShortRecord.cid` identifies that single UnixFS file and
`ShortRecord.bytes` is its length. The on-chain publication uses those values.
MP4 and MOV metadata, rotation and container layout remain unchanged in the
original.

The original identity records its SHA-256, media type and import profile
`unixfs-file-v1-262144`: CIDv1, raw leaves, 262144-byte chunks, balanced UnixFS
with 174 children per node, no directory wrapping. CID and whole-file SHA-256
are separate integrity checks.

## Prepared track timing

Video and audio tracks use one zero-based container timeline. Constant-frame-rate
sources retain their cadence up to 60 fps, including fractional rates. Variable
cadence is normalized to the probed average rate, capped at 60 fps; normalization
can repeat/drop frames. Rotation and pixel aspect are applied to display dimensions
once. Leading/trailing missing video holds the first/last frame through the
container duration. Audio timestamp gaps and a shorter audio stream become silence;
timestamp corrections use a 1 ms threshold. Mono stays mono and multichannel input
is downmixed to stereo. Main and rescue audio use the same channel layout so an
adaptive quality change does not require flushing buffered stereo audio to switch
to mono. Rescue audio remains 48 kbps AAC-LC; its measured combined HLS bandwidth
must still satisfy the cellular budget. Existing mono rescue packages remain valid.
No loudness normalization is applied.

The encoder uses FFmpeg's [timestamp-aware resampling and frame-rate filters](https://ffmpeg.org/ffmpeg-filters.html)
and trims both tracks to the validated container duration. AAC encoder priming can
add up to one 1024-sample packet (about 21 ms at 48 kHz) after HLS remuxing. This is
separate from source audio offset and is covered by the 80 ms synchronization test.
The actual filter arguments and policy revision are part of the encoding fingerprint;
existing published originals and immutable prepared packages are unchanged.

PQ and HLG sources are linearized before resizing to each rendition's dimensions.
The linear RGB resize uses a bicubic kernel (B=0, C=0.6) while converting primaries
to BT.709, then applies Hable tone mapping and limited-range BT.709 output.
Poster analysis uses the same order at its 32×32 raster, while the selected poster
frame uses the top rendition's dimensions. Every decoded source frame still
participates in selection; the frame budget and command deadlines are unchanged.
These filter arguments and the policy revision distinguish newly generated
delivery packages while preserving the original-file identity.

The top HDR rendition encodes separately to bound working memory. The smaller
renditions share one source decode and linearization, then each uses its own
cadence, resize, tone mapping and codec settings. Frame selection precedes each
smaller rendition's tone mapping so discarded frames do not incur that work;
held boundary frames still preserve the container timeline. Both commands retain
the same five-minute limit and the worker's shared processing deadline. SDR outputs remove
the source HDR mastering-display, content-light, dynamic HDR and ambient-viewing
side data after tone mapping; the retained original keeps its complete metadata.

`npm run test:shorts:quality` exercises delayed starts, shorter/gapped audio,
mono/stereo/5.1, variable cadence, fractional CFR, rotation and pixel aspect using
locally generated audiovisual markers. To include the real streaming packager,
build that repository and set `SHORTS_TEST_STREAMING_REPO` to its absolute path.
The cross-repository check decodes the resulting HLS tracks and compares encoded
packet hashes against the API outputs. These synthetic fixtures do not establish
camera/HDR quality, physical-device performance or platform parity.
The media test tools must include `libzimg` and `libx265`; the PQ/HLG tests generate
their own tagged HEVC fixtures and check neutral ordered tones in video/posters,
SDR output tags and decoded frame counts.

The rendition encoder terminates its direct FFmpeg/ffprobe
child with `SIGKILL` when work is cancelled, and wait for the child to close
before releasing scratch reservations or deleting partial output. Deadlines and
output-buffer limits use the same termination signal. Parallel version probes
are all drained before preparation can exit. The quality suite includes a child
that ignores `SIGTERM` to verify that cancelled work cannot keep writing after
the command promise rejects.

## Source posters

`poster.jpg` is rendered from a selected original frame with the same rotation,
pixel-aspect and color transforms as the video. It keeps the top rendition's
non-upscaled dimensions. Selection examines every decoded frame at a 32×32 gray
raster, prefers contrast while excluding nearly uniform black/white frames, and
uses the earliest equal score. Dark or flat scenes remain valid fallback choices;
an entirely blank clip keeps its first frame. This is a deterministic image
statistic, not semantic face or scene recognition.

The scan is bounded to 14,400 source frames (60 seconds at the 240 fps input
ceiling), with one extra frame to detect an exceeded budget, a bounded raw output
buffer of about 14.1 MiB and a 120-second deadline. The frame budget is checked
before rendition encoding. It does not rely on the container's reported frame
count. All selection parameters are part of the rendition policy fingerprint;
the exact selected frame and render command are recorded in the recipe. The
original file bytes and CID remain independent of poster selection.

The normal quality suite checks blank openings, a single visible frame, all-black
fallback, rotation and original-file integrity. Its CFR motion fixtures carry
visible frame counters, so decoded order and identity are checked rather than
only comparing total frame counts, including a full 60-second/60-fps source.

## Recoverable upload creation

With `SHORTS_UPLOAD_REQUEST_KEYS_ADVERTISED=true` (default false), hosted upload
capabilities advertise `creation: "request-key-v1"`. Clients persist
a fresh lowercase UUIDv4 `requestKey` before `POST /uploads`, together with the
file digest, byte count, metadata and expected format. Retrying that same request
returns its accepted session and echoes `requestKey`; a deliberate new upload uses
a new key. Clients must require that echo before transferring bytes. Local
`api-parts-v1` origins do not advertise this protocol.

Keys are scoped to the authenticated creator, network and contract. The durable
`shorts_upload_requests` ledger binds a key to the public request fingerprint and
server-assigned upload ID. Admission, session creation and this binding commit
atomically. Concurrent replicas return one session and charge admission once.
The accepted source profile and limit remain authoritative on replay, even if
current admission or direct-upload configuration changes. Different metadata
under the same key returns 409. Expired or cleaned sessions return 410; their
small immutable identity rows remain, without retaining source bytes, captions
or request metadata. Enqueued jobs remain recoverable and cancellation never
silently allocates another upload.

Apply migration 1793232000001 and grant the hosted API SELECT/INSERT on
`shorts_upload_requests` before enabling this API version. No worker permissions
are needed. Deploy the protocol on every API replica before enabling its capability
advertisement; stale replicas that ignore keys cannot provide this guarantee.
Disabling advertisement does not disable accepted request keys or their recovery.
The migration refuses rollback after keys have been accepted. Preserve its
ledger during storage cleanup and backups; deleting it would permit duplicate
creation after a lost response.

## Playback measurement

Playback measurement accepts both `m1` receipts and domain-separated `m2`
receipts. The latter bind the delivery CID and source key; after signature,
browser and timing checks, the API reauthorizes that exact active or retained
source against current publication policy. Analytics remain attached to the
canonical post and keep their existing deduplication/privacy rules. Version 1
receipts continue to require the published CID. Deploy these readers and clients
that accept `m2` before enabling `STREAM_VERSIONED_MEASUREMENTS` on streaming.

## Independent storage groups

| Identity | Contents | Purpose |
| --- | --- | --- |
| `cid` | Exact uploaded file | Canonical original and regeneration source |
| `derivatives.cid` | `video-{1080,720,480,360,rescue}.mp4`, optional `audio-{main,rescue}.m4a` | Temporary authenticated inputs for HLS packaging |
| `derivatives.assetsCid` | `video.mp4`, `poster.jpg`, `manifest.json`, optional `captions.vtt` | Independently retained preview/fallback and supporting assets |
| Prepared HLS index CID | Master, child playlists, initialization files and segments | Adaptive playback, stored by the streaming service |

Only the actual non-upscaled renditions appear. Video and audio input filenames
cannot occur in the assets directory, and asset filenames cannot occur in the
input directory. The public `files` array inventories both groups; routing is
defined by these closed filename sets. The three API-managed CIDs must differ.
The preview is a stream copy of a smaller available rendition, with encoded main
audio if present. It never replaces the canonical original or adds a second
video encode.

After original-format publication, moderation rescans read the recursively
pinned original through bounded scratch and verify its byte count, SHA-256 and
file CID before inspection. Authorized review previews read the durable assets
directory and verify the recorded file hash. These paths also apply after a
published post is withdrawn; inspection does not grant playback permission.
They do not fall back to encrypted processing storage when a durable source is
missing or corrupt. Pending uploads continue to use their private source and
preview.
Each operation owns one admission reservation; cancelled inspection drains before
releasing its scratch file. Storage retirement still requires the separate
retention, durable-delivery and reference checks.

The review URL also supports `SHORTS_MEDIA_TRANSFER_PREVIEW=true` with the
private transfer origin and its internal Nginx locations. A gateway request
marked `X-Shorts-Review-Gateway: internal-redirect-v1` receives its video
from the instance that verified it. The gateway strips Studio credentials from
the internal fetch. Direct API access and the default-off deployment keep
the local preview implementation.

To delegate rescans, configure `SHORTS_MEDIA_TRANSFER_URL` and
`SHORTS_MEDIA_TRANSFER_KEY_FILE`, enable scanner access on the transfer service,
then set `SHORTS_MEDIA_TRANSFER_RESCAN=true` on the hosted API. The API checks
the signed response against the request, original, and current scan generation.
It validates the frame coverage and safety decision before updating the review
record. Scanner readiness also comes from the transfer service. Local scanning
resumes when the API has its scanner endpoint and credential and the flag is
set to `false`.

`npm run test:shorts:worker` covers original-file HTTP uploads through
real PostgreSQL and S3-compatible storage when `SHORTS_TEST_PG_URL` and the
`SHORTS_TEST_S3_*` fixture settings are provided. It kills a worker holding a
claim, resumes on a new worker, and checks stale-claim rejection and the persisted
original identity. With `SHORTS_TEST_KUBO_API`, it also verifies direct original
file readback and published inspection without private-media access. These tests
use synthetic footage, a fixture moderation result and simulated chain responses;
they do not submit blockchain transactions or establish moderation accuracy.

All prepared files together are limited to 192 MiB; the retained assets subgroup
is limited to 64 MiB. These are storage limits, not creator upload allowances.
The active creator admission limit and the contract's original-file byte limit
still apply independently. HLS has its own 192 MiB package bound.

The manifest binds the original CID, SHA-256, byte count and media type to the
prepared file hashes and encoding recipe. The recipe fingerprint covers executed
FFprobe/FFmpeg arguments and hashes of their reported build/library versions;
temporary source and output paths are normalized. Deployment image qualification
is a separate operational requirement.

## Publication and recovery

Media workers have no IPFS or publishing authority. They calculate all identities
locally and persist encrypted outputs under their live job fence. The restricted
SQL completion interface binds `derivatives.generation.job/fence` to that claim
and preserves the initial original and derivative identity as immutable metadata.

After approval, the authorized publisher imports and verifies the original,
then the assets and input directories. Every byte is checked against the recorded
hash and length, including reused recursive pins. Interrupted handoffs reuse
verified completed groups and recover only missing groups. Ambiguous or corrupt
reads fail without treating the content as a successful publication.

Posters and captions are served from `assetsCid`; the streaming worker downloads
only encoded tracks from the input CID and remuxes them without lossy encoding.
Durable HLS and assets remain independently addressable if the input pin is lost.
Recovery currently restores a missing input package from encrypted preparation
outputs; a missing package must not be interpreted as intentional reclamation.

The internal preparation response returns the source key and validated HLS index.
For original-format Shorts, the API outbox marks preparation ready only after saving
that acknowledgement in `shorts_delivery_packages`. Each acknowledgement is bound
to either the immutable initial source or an accepted replacement generation in
PostgreSQL, including its job and fence. Retries reuse an identical index and
conflicting packages fail. The generated `generation_job_id` identifies the owning
reference root. These rows are immutable; rollback cannot remove used history.
The API login needs SELECT and INSERT on this table;
media-worker permissions remain unchanged.

`GET playback/:id/prepared/:sourceKey` rechecks current publication and moderation
before returning a saved index. After Redis index loss, streaming can restore it
without downloading temporary inputs or running FFmpeg. This restores metadata,
not missing IPFS blocks; it does not prove ongoing pin availability. Replacement encodes use the same fenced media-worker queue with an immutable
`delivery_short_id` link. Workers negotiate generation support; older workers skip
these jobs, and creator uploads have priority under the shared processing limit.
Prepared outputs go to `shorts_delivery_generations`, preserving the published
content row and all engagement. For original-file posts, the source CID, hash,
length and media type must match. Concurrent preparation is limited to one job per Short and the
initial history cap is eight replacement jobs, including failed jobs. Restaged
source bytes consume the existing durable ingestion reservations.

Generation output remains private and unselected. Saving a candidate HLS
acknowledgement grants no playback permission and leaves the current descriptor
unchanged. The internal `ShortsOriginalRestagingService.restage` operation rebuilds
source inputs from the pinned canonical file. It verifies the byte count, SHA-256
and deterministic file CID in bounded scratch, then reserves a replacement job and
its complete part manifest before writing encrypted 1 MiB parts. Restaging accepts originals up to the 100,000,000-byte contract ceiling
using the enlarged bounded source manifest. Captions and creator metadata are preserved; restaging
does not imply a new moderation approval.

`shorts_delivery_staging` keeps the source plan and an expiring, fenced lease.
Workers skip incomplete staging. Every stored part and manifest is authenticated
before readiness; retries reuse their reserved keys even after active-key rotation.
Three staging attempts are allowed. Recovery of an expired final attempt marks it
failed and releases its pending-job slot. Retrying a failed job still obeys queue
admission and the one-active-replacement limit. This is an explicit internal
operation, with no public endpoint or automatic scheduling. Set `SHORTS_MEDIA_TRANSFER_RESTAGING=true` with the transfer URL and key to perform
original and caption reads on the media service. The API reserves the same part
keys and issues a grant bound to the lease, generation and destination objects.
The service verifies the original CID, writes each encrypted part with a create-only
condition, and reads it back. The API verifies the response and the canonical pin,
saves and checks the metadata manifest, then finishes the fenced staging claim.
The local coordinator can resume the same reservation when the flag is disabled.

The coordinator login
needs SELECT, INSERT and UPDATE on the staging table; media workers need no new
grants. Inventory logins need read-only access to this table once installed.

The internal `ShortsDeliveryPreparationService.prepare` operation checks the
current canonical publication and the candidate's exact source, creator metadata
and caption identity. It requires an approved original and an unflagged candidate
scan of that same source. It pins and verifies the source/assets/inputs, then
requests generation-specific streaming preparation. A ready HLS package is read
through hash/length verification, with recursive original, asset and HLS pins
checked before the acknowledgement is saved. Publication is checked again after
asynchronous work. Concurrent calls are bounded and shutdown cancels transfers.
This operation has no public trigger or automatic schedule and does not approve
candidate moderation or select playback.

`GET playback/:id/generations/:jobId` exposes only authorized public file metadata;
the corresponding `prepared/:sourceKey` child route returns a saved HLS index.
Neither discloses private object references or review evidence.
`GET playback/:id/versions/:sourceKey` is the historical playback lookup. It admits
the active version and recently retired selected versions, under current canonical
publication permission. Prepared candidates alone have no historical serving rights.

## Selection and rollback

`ShortsDeliveryActivationService.select` is an internal operation with no creator
HTTP writer. New selections require `SHORTS_DELIVERY_SELECTION_ENABLED=true`;
the default is disabled. Callers provide the expected active source key and revision
plus a UUID operation identity. The coordinator verifies the target's exact original,
retained assets and every HLS file, then verifies the previous delivery. It never
restores temporary encoded inputs merely to perform a switch. Current canonical
publication is rechecked around asynchronous work.

`shorts_delivery_selections` records each successful switch as an immutable event.
A transaction locks the canonical post and compares the expected source/revision
against the latest event. Database guards require acknowledged packages and eligible
same-source metadata; media workers have no selection-table privileges. Concurrent
writers cannot overwrite one another, including a change away from and back to
the same source. Retries with the same operation identity return the committed
receipt after an uncertain response. A reused operation with different arguments
fails. History is bounded to 1024 transitions per post, with the final slot
reserved for rollback; reaching the limit requires an operational migration
before more switches. History cannot be updated,
deleted, truncated or dropped through a used migration rollback.

Rollback remains available when new selections are disabled, and its target must
have been selected previously. It verifies that target without requiring a damaged
current HLS package to become healthy first. Original files, acknowledgements and
the damaged version's references remain intact. Neither direction rewrites the
canonical content row, on-chain identity or engagement.

The streaming descriptor, poster and caption reads resolve the selected delivery.
An old v3 playback session can resolve its retired version for 3720 seconds after
the database-recorded switch: the maximum supported 3600-second token lifetime,
30-second catalog cache and a 90-second allowance. Historical reads never extend
that window. Future reclamation must honor it and coordinate with in-progress
verification; expiry by itself grants no deletion authority. The API coordinator
needs SELECT and INSERT on the selection table; workers need no new grants.

Retention and pin inventories enumerate original, input, asset and acknowledged-HLS references
separately and propagate holds to each. Inventory observations never authorize
deletion. Reclaiming inputs requires a coordinated delivery lifecycle, verified
durable playback/fallback, live reference and hold checks, and recovery/rollback
windows. Keep them pinned until those conditions are enforced by that lifecycle.

### Intentional retirement of encoded inputs

The hosted `ShortsDeliveryRetirementService.retireInputs` operation ends automatic
restoration of one generation's intermediate encoded-input package. It is internal,
has no creator HTTP route or scheduler, and defaults off through
`SHORTS_DELIVERY_INPUT_RETIREMENT_ENABLED=false`. Set only `true` or `false`.
It verifies current serving authorization, the complete original and durable
asset/HLS bytes and pins, then records an immutable retirement receipt. Two
operations may run concurrently, with a five-minute deadline and shutdown/parent
cancellation. A retry of a committed operation returns its receipt without media
I/O, including when new retirements are disabled, but still checks serving policy.

Migration `1793145600001-ShortsAdaptiveDelivery` binds each receipt to the
acknowledged source key, input CID and generation job. The database requires an
eligible published original, an eligible previously selected replacement when
applicable, no active per-post/generation hold, no pending appeal or unresolved
reports, and no active preparation of that generation. It preserves inputs for
3720 seconds after acknowledgement and any selection involving the version.
Identity, on-chain metadata, engagement, assets, HLS acknowledgements and selection
history remain unchanged. Another generation using the same input CID still
requires its own retirement; a shared CID is not enough. Media workers have no
read/write permission on this table. Used retirement history cannot be rolled back.
The hosted API requires SELECT and INSERT on the retirement table; recovery and
preparation require SELECT. These grants do not confer pin-removal authority.

Hosted recovery consults this ledger before repairing a published original-format
post. For retired inputs it verifies/restores only the original and durable assets.
A failed or mismatched ledger read defers recovery instead of guessing. Explicit
candidate preparation also verifies retained delivery and restores streaming
readiness without repinning retired inputs. Newly pending publication still
requires all input packages.

A receipt records a logical retirement, **not physical deletion permission**. It
does not unpin anything, delete private objects, run GC or change inventory reference
counts. It must not be used alone to reclaim a shared CID. Physical reclamation
requires fresh global reference/hold and selection-window checks, quiescence for
all writers, a bounded expiring gateway permit, and durable uncertain-outcome
recovery. Holds or selections added after retirement must still be honored. Keep
automatic cleanup disabled until those protections are connected.

### Verified private processing references

Migration `1793232008001-ShortsPrivateMediaCleanup` preserves each accepted upload's
exact source manifest on its ingestion job. Ordinary shared uploads and replacement
staging save it in the job-admission transaction. The internal generation admission
method also accepts this document. Database validation binds its bytes and SHA-256
to the encrypted manifest reference and checks the source identity, frozen limit,
complete ordered parts and scoped object identities. Once bound, the document and
source identity are immutable; worker lease/status changes remain available.
Manifest binding advances the private-reference change counter. Public job results
and the media-worker repository do not include the plaintext manifest.

Before this migration, the same writers remain compatible with older schemas.
Existing or older-writer jobs can have a null manifest; a retry with the exact
verified document can bind it once. Do not interpret null as an empty part list or
as cleanup eligibility. Saved manifests alone do not authorize deletion. Used
manifest history prevents destructive job deletion and migration rollback.

`ShortsPrivateInputRetirementService.retireInputs` records the encrypted processing
objects associated with one acknowledged original-format delivery. It has no HTTP
route or scheduler and defaults off through `SHORTS_PRIVATE_INPUT_RETIREMENT_ENABLED`.
Only `true` and `false` are accepted. The coordinator requires the encoded-input
retirement receipt above, rechecks serving policy, verifies the complete durable
original, assets and HLS package, and authenticates the bounded source manifest.
It permits two concurrent operations with a five-minute deadline and shutdown or
parent cancellation. Committed UUID retries return metadata-only receipts without
repeating media reads, including when new retirement is disabled.

Migration `1793232008001-ShortsPrivateMediaCleanup` captures the exact source
manifest and deduplicated object references from private rendition files, source
parts, upload parts and direct-upload permissions. Its database guard rechecks the
existing retirement policy and completed source job, then validates the manifest's
byte count, SHA-256, identity, part ordering, scope and object identities. A changed
source, upload or staging record invalidates the proof. Engagement updates and
unrelated uploads do not invalidate it. The original source limit saved at admission
remains binding. Receipts are immutable; rollback refuses to discard used history.

The hosted API needs SELECT and INSERT on `shorts_private_input_retirements`,
EXECUTE on `shorts_private_input_snapshot(text,text,text,text)`, and its existing
canonical-content row-lock permissions. Media workers receive no grants. Snapshot
and commit operations require READ COMMITTED transactions with bounded lock and
statement timeouts. The snapshot invokes the existing encoded-input guard through
a duplicate insert that cannot change the prior receipt.

This record does not suppress retention references, remove encrypted objects or
delete object versions. It is not a physical cleanup permit. Shared references,
late writes, renewed holds and provider deletion outcomes still require fresh
checks and separate deletion authority. The original IPFS file, on-chain CID,
metadata, engagement and durable playback packages remain unchanged.

Reference scanners can use the immutable receipt's authenticated manifest after
its encrypted object has disappeared. They revalidate it against every current
source claim and retain all object edges and holds. Grant their restricted SQL
roles read-only access to this table when the migration is installed; see
[storage reference reconciliation](STORAGE-REFERENCES.md). A missing storage
object is not itself a cleanup success or a reason to skip reference validation.

### Private-object reference barriers

Migration `1793232008001-ShortsPrivateMediaCleanup` provides an internal,
explicit per-scope enrollment for retiring temporary encrypted objects. Enrollment
is permanent and initially empty. It requires new or changed opaque source claims
to have an authenticated document bound to the ingestion job. Claims recorded before enrollment remain protected by normal reference scans. Deferred constraints inspect
the final admission transaction, so inserting a job and binding its manifest in
that transaction is supported. Upload parts, direct-upload intents, private output
files, staging documents and hidden source-manifest children all participate.

`ShortsPrivateReferenceBarriersService` reserves a key only against a completed,
current reference scan and version inventory. Each referencing root must have a
matching private-input retirement receipt and pass the current retirement policy.
Canonical content rows are locked in order before the reference epoch. Conflicting
identities, active work, holds, unretired shared references and pending historical
version cleanup prevent reservation. The database derives the object identity and
complete root bindings; callers cannot supply replacement proofs.

A reserved key cannot gain new references. An unsealed reservation can be cancelled;
a sealed reservation is a permanent tombstone, including after a crash or uncertain
provider outcome. Holds and reports remain admissible and invalidate fresh cleanup
proofs. Sealing checks a fresh scan, but an idempotent retry returns the saved receipt:
neither a reservation nor a seal authorizes deletion or certifies current durability.
Every physical dispatch still needs separate, fresh original/assets/HLS verification,
bounded provider authority, immutable version identification and confirmed absence.

The internal operator needs SELECT/INSERT on `shorts_private_cleanup_scopes` and
`shorts_private_input_barriers`, UPDATE only on the barrier's `state` and
`seal_scan_id`, and EXECUTE on `shorts_private_barrier_lock(text,text)` and
`shorts_private_barrier_proof(text,text,uuid,text)`. It needs no epoch-table writes.
Media workers receive no barrier-table or helper grants. There is no public route,
scheduler, automatic enrollment or object deletion in this service. Enrollment and
barrier history cannot be deleted, truncated or rolled back after use.

`ShortsPrivateInputVersionStorageService` provides the internal version I/O for
that coordinator. It streams and authenticates the exact candidate before asking
for authority, then requires the returned grant to match the scope, complete
object reference and immutable version ID. It snapshots caller-owned identities
across asynchronous work. Dispatch rechecks authority and uses a 30-second signed
DELETE tied to the grant's timestamp; excessive clock skew, unsafe bucket settings,
unreadable missing versions, redirects and unconfirmed absence fail closed.

Removal may include the current or final encrypted copy. Each result concerns one
version only: deleting the current copy can expose an older copy, and a later write
has a distinct identity requiring another authenticated operation. Recovery observes
the exact issued version and must not infer that the entire key has been reclaimed.
The provider contract follows [S3 version-specific deletion](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html)
and [signed-URL expiration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html).
Expiry controls request admission; it does not cancel an already accepted request.

The historical version cleanup command still requires a retained current copy.
The separate private-input cleanup coordinator below connects this I/O service to
fresh API verification and the SQL journal for eligible current or final versions.
A caller-supplied callback or a saved barrier is not production proof.

### Explicit retirement and barrier commands

The existing `shorts:delivery-operations` Nest entrypoint exposes these operations
without a listener, hosted background jobs. Pass one action
and an absolute request JSON path. Every request below includes `scope` with exactly
`network` and `contract`, which must match the loaded storage deployment. Existing
delivery request formats are unchanged.

| Action | Additional request fields |
| --- | --- |
| `retire-encoded-inputs` | `id` (Short), `sourceKey` (acknowledged SHA-256), `operation` (UUID v4) |
| `retire-private-inputs` | `id`, `sourceKey`, `operation` (UUID v4) |
| `barrier-enrol` | `confirmPermanent: true` |
| `barrier-reserve` | `id` (barrier UUID v4), `scan` (reference scan UUID v4), `objectKey` |
| `barrier-seal` | `id`, `scan` |
| `barrier-reserve-seal-batch` | `scan`, `confirmPermanent: true`, `items` (1–100 unique `{id, objectKey}` entries) |
| `barrier-status` or `barrier-cancel` | `id` |

Retirement commands invoke the existing guarded services and retain their
default-off flags. Enrollment, reservation and sealing additionally require
`SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED=true` in the explicit operations process;
it defaults to `false` and accepts only those two values. Status and cancellation
remain available when new barriers are disabled. Cancellation still uses the
database guard and cannot cancel a sealed barrier. Barrier replies omit object keys
and reference details. Enrollment is idempotent by the existing unique storage
scope; it has no invented per-request retirement receipt.

The batch action validates every item before starting, then reserves and seals
each key sequentially in one Nest context. It uses the same per-call database
guards and transactions, with a two-minute deadline and parent cancellation.
Any failure or interruption stops further calls; already committed barriers stay
saved and must be inspected with `barrier-status` before resuming. A source change
can still invalidate the reference scan. Batching avoids repeated process startup;
it does not relax scan freshness or make the whole batch one transaction.

The sequence is encoded-input retirement, private-input retirement, explicit
permanent enrollment, a fresh completed reference scan, then reservation/sealing
of one exact key. Reuse the same operation or barrier UUID when observing an
interrupted step. Source/hold changes may require another fresh scan; a saved scan
or retired receipt never bypasses the existing live guards. These commands do not
grant database permissions, mint provider credentials, enable the API verifier,
remove object versions or unpin IPFS content. The separate cleanup operator below
still requires its own reviewed privileges and a fresh durable-media proof.

### Private version cleanup journal and verification

Migration `1793232008001-ShortsPrivateMediaCleanup` records an immutable
operation for one inventoried version behind an already sealed reference barrier.
`shorts_private_input_verifications` stores the media verifier's proof;
`shorts_private_input_attempts` consumes that proof once; and
`shorts_private_input_outcomes` records uncertain or confirmed removal. An outcome
requires an issued attempt. Confirmed removal prevents another dispatch, while
outcome recording remains available after a hold or withdrawal. Used history cannot
be updated, deleted, truncated or rolled back.

The sealed snapshot rechecks every stored sharing root and the object owner's
current policy under canonical-row and epoch locks. It binds private source state,
original/derived identities and acknowledged HLS metadata into a state hash. Since
the permanent barrier prevents new references, unrelated uploads and engagement
counters may change while verification runs. Changes to relevant roots, holds,
reports, appeals, active work, deployment identity or rollback windows still block
verification and dispatch. Disabled reference guards also block this path.

The hosted API exposes the service-authenticated endpoint
`POST /shorts/internal/private-input-cleanup/:operation/verify` with the sole JSON
field `verificationId` (a fresh UUID). It defaults off through
`SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED=false`. Enabling it requires an absolute
`SHORTS_STORAGE_CONTROL_TOKEN_FILE`; authentication rejects browser Origin headers
and reads the credential on each request so rotation takes effect immediately.
Its enablement is independent of `SHORTS_IPFS_EXPIRING_WRITES` and does not enable
the pin-control routes.

`ShortsPrivateInputCleanupVerifierService` checks serving eligibility, reads and
verifies the original file, durable supporting assets and complete HLS package for
each sharing root, then commits the proof only if the bound state is still current.
It permits two concurrent operations, with a five-minute deadline and shutdown or
parent cancellation. The reply contains only verification/operation IDs and database
timestamps. Proofs expire after 30 seconds; issuance rechecks policy and cannot reuse
a proof. Every pre-dispatch check revalidates the relevant state and the issued
30-second deadline. Neither an expired proof nor an old attempt can be renewed by
retrying its ID.

Cleanup control uses a separate SQL login from the publication-bound API login.
When private retirement, barriers or the HTTP verifier is enabled, mount
`SHORTS_CLEANUP_CONTROL_DB_CREDENTIALS_FILE` as an absolute, private, process-owned
JSON file containing only `username` and a 64-character lowercase hexadecimal
`password`. The username must differ from the primary API login. The dedicated
pool reuses the configured primary PostgreSQL endpoint, with one connection,
a one-second connection bound, 15-second statement bound and 25-second operation
bound. It is drained independently on shutdown. Do not grant the cleanup helper
functions to the publication login: its existing authority check intentionally
rejects foreign SECURITY DEFINER execution rights. Encoded-retirement ledger
reads stay on the normal connection; its explicit operations context additionally
needs only INSERT on that ledger.

The private-retirement, barrier and verification-journal DAOs use the control
connection. All ordinary publication checks and serving eligibility checks retain
the normal API connection. The control login may not publish, change source rows,
or insert deletion attempts/outcomes. Private retirement takes canonical/epoch
locks through its existing guarded snapshot function and needs no source UPDATE
grant. With the control features disabled and no credential file, these DAOs use
the existing connection; the isolated deletion CLI therefore keeps its separately
restricted operator role. Never mount control credentials in that operator.

Both internal roles need SELECT on the four journal tables and
`shorts_private_input_barriers`, plus EXECUTE on
`shorts_private_cleanup_snapshot(uuid)`. Only the separate control login receives INSERT on
`shorts_private_input_verifications` and EXECUTE on
`shorts_private_cleanup_lock_batch(text,text,uuid[])`. Only the deletion operator receives INSERT
on `shorts_private_input_cleanup`, `shorts_private_input_attempts` and
`shorts_private_input_outcomes`, plus EXECUTE on
`shorts_private_sealed_snapshot(uuid)` and `shorts_private_cleanup_dispatch(uuid)`.
Neither needs journal UPDATE/DELETE or epoch writes. Media workers receive no such
grants. Keep API media-service credentials separate from operations deletion
credentials. The deletion operator also reads `shorts_runtime` to check its
configured deployment. It must not mint verification proofs, change source or
inventory rows, edit holds, enrol scopes or rewrite sealed barriers.

`ShortsPrivateInputCleanupModule` is an operations-only Nest application context.
It has no listener or scheduler and never imports the API media or publishing
modules. Use `npm run shorts:private-input-cleanup -- <action> /absolute/request.json`:

- `reclaim`: `{ "id": "<operation UUID>", "barrier": "<sealed barrier UUID>", "inventory": "<completed inventory UUID>", "identity": "<inventory item SHA-256>" }`.
- `reclaim-batch`: `{ "operations": [<reclaim request>, ...] }`, with 1–128 distinct operation IDs.
- `status` or `recover`: `{ "id": "<operation UUID>" }`.

The process defaults to `SHORTS_PRIVATE_INPUT_CLEANUP_OPERATOR_ENABLED=false`.
Status and recovery remain available when deletion is disabled. It uses the same
isolated deployment, private storage and encryption configuration as storage
reconciliation; IPFS, streaming, moderation, signing and ambient AWS credentials
remain forbidden. `SHORTS_STORAGE_CONTROL_URL` is the hosted API HTTPS origin
(HTTP is allowed only on loopback outside production), and
`SHORTS_STORAGE_CONTROL_TOKEN_FILE` mounts the verifier credential. The client
includes the `/api` prefix, rejects redirects, bounds individual responses to 4 KiB
and batch responses to 64 KiB, and reads
the token for each request. Do not pass a URL containing `/api` or credentials.

The operator checks its restricted database grants before work. For each exact
version it authenticates the candidate's encrypted bytes, requests fresh API media
verification, records a new issued attempt, then rechecks policy before sending
the signed DELETE. The signature expires no later than the SQL media proof,
rounded down to whole seconds. It handles one operation at a time with a six-minute
deadline and drains cancellation on shutdown. It never automatically retries a
failed DELETE. `recover` observes only the exact version of an already issued
attempt and records confirmed absence; a missing unissued version is not success.
An interrupted issue, provider response or outcome commit remains recoverable from
the immutable journal. A confirmed outcome is idempotent and does not repeat media
reads or deletion. Later writes create separate versions and require their own
inventory and authority. A completed operation does not claim the entire key is
empty, and sealed reference barriers must remain permanent.

Use `reclaim-batch` for a Short's upload parts and other eligible inputs. It first
authenticates every pending candidate version, retaining only a one-use dispatch
handle and immutable identity. It then calls
`POST /shorts/internal/private-input-cleanup/verify-batch` with
`{ "operations": [{ "operationId": "<UUID>", "verificationId": "<fresh UUID>" }, ...] }`.
The API takes one bounded SQL snapshot at a time and deduplicates identical durable
roots within that request. The database derives each root's durability hash from
its retirement binding, original identity, derivative files, captions, duration
and acknowledged delivery package. Distinct roots remain separate. At most 256
distinct roots and 16 MiB of retained root metadata are admitted per batch; each
individual SQL closure remains subject to its 8 MiB limit.

Every distinct root is physically verified once. All proofs are then inserted
atomically after locking every canonical Short in order, followed by the reference
epoch. Each proof has its own immutable operation binding and the same database
transaction timestamp and 30-second expiry. A changed root or hold rolls back the
entire proof batch. These checks are never cached across requests. A delayed proof
transaction consumes its existing validity window rather than extending it.

The operator issues and rechecks each version's attempt immediately before its
DELETE; individual signatures remain bounded by the shared proof expiry. If the
batch expires or is interrupted, completed outcomes persist and the remainder
needs a new verification request. Retry skips confirmed removals and first
observes unresolved issued versions. It does not renew an old proof or replay an
old destructive attempt. `status` returns the latest 64 attempts and their outcomes
with `historyTruncated` when older history exists; all history remains in SQL.

### Shared-CID reclamation reservations

Migration `1793145609001-ShortsStorageReclamation` adds a persistent
reference barrier for retired input CIDs. The internal
`ShortsInputReclamationReservationsService` reserves one CID with a UUID operation,
returns its bounded set of reference roots, verifies it again, or cancels it. It
has no scheduler, public route, IPFS credentials or deletion method. Reservations
are global across every network/contract in the database. At most 64 roots may
participate in one reservation; exceeding that limit refuses the operation.

Admission checks every initial/generation input reference for durable HLS
acknowledgement and its own retirement receipt, current publication/moderation,
metadata consistency, holds/reports/appeals, active preparation and the current
3720-second retry/rollback window. Any original, asset or acknowledged HLS
use of the CID prevents reservation. CIDv0 legacy references are normalized to the
equivalent dag-pb CIDv1 pin identity, including when new references are created.

Transaction-scoped CID locks serialize reservation admission with content,
generation, package and selection writes. An active reservation rejects new
references and affected selection switches. New holds, policy changes or active
preparation invalidate the reservation without blocking those policy actions;
engagement-only changes remain allowed. Invalidated reservations continue blocking
new references until explicitly released. A process restart or elapsed time never
releases one. Transactions use READ COMMITTED so a lock wait cannot leave admission
using an older snapshot. The bounded reference lookup and verification must run
through the dedicated Shorts database pool.

The operator connection needs SELECT/INSERT/UPDATE on the reservation table and
EXECUTE on `shorts_input_reclamation_roots(text)`; media workers receive neither.
The pure CID identity conversion contains no data access and is available to
index evaluation. Reservation identity and reference history cannot be changed,
deleted or truncated, and a used migration cannot be rolled back. Cancellation is
idempotent; the same operation cannot reopen a released reservation, while a new
operation can reserve a safely reused CID after rechecking all references.

The reservation itself is not a destructive permit. Migration
`1793145609001-ShortsStorageReclamation` adds a separate immutable permit ledger.
`ShortsInputReclamationPermitsService` issues at most one operation per reservation,
under the CID lock and a fresh reference/policy check. Database time fixes a
20-second expiry and another 30-second quiet period. Retries return the same
receipt; they never extend authority or issue another operation for that reservation.

Cancellation releases coordination, not an already issued request. Database
triggers prevent barrier release while the permit is issued/uncertain or its quiet
period remains. Expiry alone never releases an unknown outcome. Known removed,
not-pinned or rejected outcomes still retain the barrier through the quiet period.
Policy changes can invalidate a reservation while retaining its outstanding permit
barrier. Worker roles cannot access the ledger; used history cannot be deleted,
truncated, rewritten or rolled back. Normal outcome recording cannot resolve an
uncertain operation without a separate recovery protocol.

The hosted coordinator needs SELECT/INSERT/UPDATE on this ledger; it does not need
DELETE or TRUNCATE authority.

The ledger itself dispatches no storage request. The internal
`ShortsInputReclamationService.reclaim(cid, operation)` coordinates physical input
unpinning when `SHORTS_DELIVERY_INPUT_RECLAMATION_ENABLED=true`. It defaults off,
requires expiring API writers and a strict gateway with clock protection, and has
no public route or scheduler. Apply `1793145609001-ShortsStorageReclamation` first.
The operation reserves all references, verifies the original, assets and durable
HLS for every root, then obtains and binds an expiring permit. Roots outside the
coordinator's configured deployment fail closed; a cross-deployment coordinator
must verify their chain authority before supporting them.

Only the database transaction that creates a permit may dispatch its unpin.
Retries and process restarts report existing authority without another mutation.
Calls are bounded to two concurrent operations with a ten-minute verification
deadline. Withdrawal, corruption, holds, ambiguous storage responses and uncertain
database outcomes prevent final cleanup. A storage request already admitted may
finish after policy changes; the reference barrier, private copies and disabled
garbage collection preserve recovery. A known unpin receipt still retains the
reference barrier through the database quiet window.

`release(operation)` completes a known bound outcome after that window. It checks
the same peer/process, synchronized clocks, strict admission, node health and the
actual recursive pin, then checks node health again. An immutable release proof
and barrier release commit together under the CID lock, with fresh reference and
hold checks. Bound permits cannot bypass this proof through ordinary cancellation.
The coordinator login needs SELECT/INSERT on `shorts_input_reclamation_releases`;
workers receive neither. Used release/bound-permit history cannot be rolled back.
Finishing an existing known release is available when new reclamation is disabled.

The `shorts:delivery-operations` CLI also exposes `reclaim-input` with
`{ "scope": { "network": "...", "contract": "..." }, "cid": "<canonical input CIDv1>", "operation": "<UUID v4>" }`.
Use `input-reclamation-status`, `release-input` or `recover-input` with the same
`scope` and `operation` fields and no `cid`. The latter invokes only the existing
unpin recovery service; it does not restart the node or resend a destructive request.
The request scope must match the loaded storage deployment, and every saved
reservation root must belong to it. Replies contain compact reservation/permit
state and release/recovery observations, without root details or storage epochs.

These commands preserve the existing default-off reclamation/recovery flags and
all capability, clock, reference, durability and quiet-window checks. New
reclamation requires `SHORTS_IPFS_EXPIRING_WRITES=true` and gateway capabilities
with `legacyWritesEnabled=false`; a flag in one operator process cannot establish
exclusive writer control. All writers using the same gateway must be accounted
for before strict admission is enabled. Status does not issue authority; a replay
of a saved issued/uncertain operation cannot dispatch another unpin.

An unknown outcome or changed node epoch uses the separate storage recovery
operation below. Unbound historical requests and quarantined nodes cannot be
resolved by assuming success. Removing a pin does not free blocks immediately. Private
object/version deletion, garbage collection and automatic cleanup remain disabled.

### Outstanding storage writes

Migration `1793145609001-ShortsStorageReclamation` records CID-bound pin intents in the
shared database. `ShortsPinTransfersService` issues a UUID with a database-generated
180-second expiry and a further 30-second quiet period. Identity, purpose, scope
and timestamps are immutable. The same operation returns its existing receipt
without renewing authority. Media workers have no access to this table; the hosted
API needs SELECT/INSERT/UPDATE. A used migration refuses rollback.

Issued or uncertain transfers block reclamation until an immutable recovery record
resolves their old process authority; expiry alone is insufficient. Known pinned/rejected outcomes continue blocking through the full quiet
period because a delayed copy of the request may still arrive. Transaction-scoped
CID locks serialize transfer creation with reclamation admission in either order.
An active reclamation reservation refuses new transfers. A successful transfer
cannot be recorded after its authority expires. Neither an HTTP timeout nor a
service restart proves that an importer stopped; uncertain outcomes require node
recovery and pin reconciliation before reclamation can proceed.

Migration `1793145609001-ShortsStorageReclamation` adds immutable node bindings
(`node_peer_id`, `node_epoch`, `storage_bound_at`) to both pin transfers and unpin
permits. Issue authority first, negotiate the gateway, then bind its peer ID and
process epoch in the database before sending a mutation. Only an unexpired issued
operation can acquire its first binding. Concurrent callers cannot choose different
epochs for one operation; a restart or credential rotation never renews its expiry.
Unpin binding also rechecks the reservation's current roots and retention policy.
Existing unbound history stays unbound; do not infer its process from a later probe.
A used binding migration refuses rollback. These bindings are recovery evidence,
not permission to overwrite an uncertain outcome or publish an old prepared package.

`SHORTS_IPFS_EXPIRING_WRITES=false` preserves the existing API transport during
rollout. With `true`, hosted API uploads for originals, assets, processing inputs
register an intent before using the guard's `shorts/add`
route. The request binds its expected CID, operation, expiry and recorded storage epoch. The API requires
an exact matching pin receipt before recording success and never retries through
legacy `add` after an ambiguous response. Hash-only CID calculation is unchanged.
Only `true` and `false` are accepted; this mode requires shared metadata.

Enabled indexed APIs also require an absolute `SHORTS_STORAGE_CONTROL_TOKEN_FILE`
containing a separate 64-character hex worker-to-API key. The service-only
`POST /shorts/internal/storage/:id/pins`, `/pins/bind` and `/pins/finish` endpoints require this
Bearer credential, refuse browser-origin requests and reload the mounted key for
rotation. Begin reauthorizes the exact playback source/generation; finish only
records the bound upload outcome and remains usable after withdrawal. Neither
endpoint publishes content or selects a delivery generation.

For a new durable HLS acknowledgement, the API obtains separate fresh pin
authority, verifies original/assets/HLS pins and every prepared file, rechecks
publication policy, then inserts the package and consumes the permit in one SQL
transaction. A storage receipt or old Redis entry alone cannot authorize this
transition. Existing acknowledgements remain immutable. This protocol changes
neither the canonical original CID nor the HLS source key or package wire format.

Capability negotiation requires `epochVersion: 1`, a valid node peer ID and epoch,
and both `writing` and `uncertain` false. Upload receipts must echo that epoch.
It also requires `addVersion: 1`, a 300-second maximum permit
lifetime, a 120-second import timeout and `serverTimeUnixMs`. Storage and database
observations must each be within five seconds of the API clock; otherwise no import
is dispatched. Keep all hosts synchronized and monitor clock changes throughout
permit lifetimes. The quiet period is not a substitute for clock monitoring or
recovery after an uncertain mutation.

### Recovery after a storage-process restart

Apply `1793145609001-ShortsStorageReclamation` before enabling
`SHORTS_STORAGE_RECOVERY_ENABLED=true`. It defaults off and requires expiring API
writers. The internal `ShortsStorageRecoveryService.recover(kind, operation)` accepts
`pin` or `unpin`, and observes an already restarted paired guard/Kubo process. It
does not restart infrastructure, send another storage mutation or publish media.
Keep the supported single-node topology: a cloned peer identity or independently
running replica does not prove that the old process stopped.

Each request must already have a recorded node binding. Recovery requires the
same peer, a different epoch, strict admission, clock protection, an elapsed quiet
period and a healthy idle node. It checks the actual recursive pin and rechecks
node health/epoch before committing. Unpin recovery also re-verifies every retained
original/assets/HLS root and current publication/policy. Retention holds, changed
references, withdrawal, corruption or a foreign deployment leave its barrier intact;
resolve those conditions before retrying. Historical unbound requests cannot be
assigned a node retrospectively and need a separately verified recovery procedure.

`shorts_storage_recoveries` records the old state/epoch and new node observation
under the CID lock. Unpin recovery and barrier release commit together. The original
receipt stays unchanged, and late outcome updates cannot overwrite recovered
authority. Retries, concurrent callers and lost database acknowledgements return the
same recovery record; a completed record can be read while new recovery is disabled.
Every unresolved transfer must be recovered individually before its CID can enter
reclamation. A pin observation is not media verification or renewed publishing
authority: use a new transfer and the normal verification flow to publish or repair.

The hosted coordinator needs SELECT/INSERT on the recovery table; workers receive
neither. History cannot be edited, deleted, truncated or rolled back after use.
Recovery has two-operation concurrency and a ten-minute deadline with cancellation
and shutdown draining. It has no public route or automatic timer and does not enable
private-version deletion or garbage collection.

Physical reclamation additionally requires `clockGuardVersion: 1` and
`clockMaxDriftMs: 5000`. The gateway compares wall time against a process-lifetime
monotonic anchor and quarantines writes after excessive drift. Correcting wall time
does not clear quarantine. This prevents an expired request from becoming valid
again after its reference barrier has been released.

### Automated quality and lifecycle checks

`npm run test:shorts:quality` runs the source-identity, encoding, streaming-file,
upload-policy, delivery-generation, selection, retention and storage-authority
suites sequentially. Install FFmpeg/ffprobe and set `SHORTS_TEST_PG_URL` to an
isolated loopback PostgreSQL instance; these tests create and remove their own
schemas and database roles. Branch CI provides PostgreSQL 16 and media tools.
Optional live-Kubo cases require `SHORTS_TEST_KUBO_API` pointing to a disposable
local node and otherwise report explicit skips. These checks do not establish
physical-device performance, full production-topology recovery or quality parity.

Enable strict gateway admission only after every writer, including streaming and
operational smoke checks, uses durable intents and expiring operations. This flag
does not enable input reclamation or private-media deletion. Existing original
CIDs and derivative formats remain unchanged.

## Reader compatibility

Apply migrations through `1793145609001-ShortsStorageReclamation`, including
the file-reference size migration, before admitting this profile. API, streaming origin/worker and inventory readers must support the
same descriptor. Shared `hls-v3` compatibility vectors bind required network and
contract, original identity, both directory CIDs, recipe fingerprint, generation
job/fence and file/rendition metadata.
Client-supplied processing profiles are discarded; the profile must be chosen
by server policy when the upload is accepted and persist through retries.


The UnixFS request profile is centralized in `shorts-ipfs-import-profile.ts`.
Original and derivative imports explicitly select CIDv1/raw leaves,
SHA-256, 256 KiB chunks, balanced layout, 174 file links and canonical directory
parameters; filesystem metadata and inline CIDs remain disabled. Deploy the
matching storage gateway before the API. Kubo startup also fixes DAG-PB field
order and the directory sharding threshold, which cannot be overridden per add.
These settings preserve the existing calculated CIDs. The expected-CID preflight
must still succeed before the expiring importer stores blocks or changes pins.

## Combined private cleanup integration test

`npm run test:shorts:worker` supports an opt-in integration path with
`SHORTS_TEST_CLEANUP_MEDIA=1`. Provide disposable loopback PostgreSQL and MinIO
fixtures using the `SHORTS_TEST_PG_URL`, `SHORTS_TEST_S3_ENDPOINT`,
`SHORTS_TEST_S3_ACCESS_KEY` and `SHORTS_TEST_S3_SECRET_KEY` settings, enable
`SHORTS_TEST_MINIO_STS=1`, and set `SHORTS_TEST_KUBO_API` to an offline Kubo
RPC endpoint including `/api/v0`. Set `SHORTS_TEST_STREAMING_REPO` to the absolute
path of the built `streaming/` module in a matching `superhero-shorts` checkout.
Set `SHORTS_TEST_INGEST_ROOT` to its built `ingest-worker/` directory.
The test uses FFmpeg/FFprobe from `PATH` and creates its own versioned bucket,
database schema and restricted principals. Use isolated fixtures with no other
workloads; the test removes its owned versions, pins and database objects.

This path uploads an owned portrait 1080p/60fps video with audio through the
actual encrypted HTTP upload flow, restarts a killed media worker, and uses the
streaming service's real IPFS and adaptive preparation providers. It acknowledges
the resulting HLS package, captures authenticated retirement references, runs a
physical inventory and reference scan, and boots the cleanup operations module
with restricted SQL and version-scoped storage credentials. The API performs
real original/assets/HLS verification before deletion. Fault cases exercise
unauthentic ciphertext, missing pins, altered media responses, retention holds,
proof expiry and a lost provider response followed by module restart. The final
check reads the exact original CID and decodes every retained HLS track after
eligible private versions have been removed.

The fixture advances only the initial acknowledgement's rollback clock using
its database owner; dispatch proof expiry uses real elapsed time. Chain
confirmation and safety decisions remain controlled test inputs. This does not
exercise live publication, the streaming edge's HTTP authorization, other storage
providers or physical mobile devices. It does not enable deployed cleanup flags.

For the additional encoded-input reclamation path, set
`SHORTS_TEST_INPUT_RECLAMATION=1` alongside the cleanup-media settings. Supply
`SHORTS_TEST_KUBO_GATE` (the actual admission guard's loopback `/api/v0` URL),
`SHORTS_TEST_IPFS_TOKEN_FILE` (an absolute path to its disposable writer key), and
`SHORTS_TEST_KUBO_CONTAINER`. The container must have the name
`sh-shorts-reclaim-<UUID>` and label `org.superhero.test.reclamation=true`; its
guard port must match the supplied endpoint. Publish both guard and raw RPC ports
on fixed loopback host ports so a container restart retains their addresses.
Use the current guard and paired
Kubo with expiring writes required. The fixture's separate, loopback-only raw RPC
must refer to that same node and allow its owned pin restoration, `repo/gc` and
`block/stat` fault checks. These extra raw permissions are test-only and must
never be added to deployed credentials or exposed by the production guard.

This extension uses a restricted coordinator SQL login, the real reference
barriers, expiring permits and authenticated unpin transport. It checks permanent
roots and holds, waits out real quiet periods, discards a completed unpin response,
restarts coordinator instances without resending the mutation, then restarts only
the verified disposable container to exercise storage-epoch recovery. Finally it
runs garbage collection on that disposable node, checks that the encoded-input
root block is absent, and rereads the original and decodes every HLS track.
Production garbage collection remains a separate, disabled operation.

After garbage collection, the same opt-in path restages from the retained
original into new bounded encrypted parts and runs the restricted media worker
again. An absent original pin must prevent restaging without creating a job or
private versions. The candidate uses fresh expiring pin authority, real streaming
preparation and durable acknowledgement, then exercises activation and rollback.
The original CID, canonical record and controlled chain state remain unchanged;
every rebuilt HLS track is downloaded, verified and decoded. Shared transfer
admission remains isolated by this fixture. This path does not qualify
distributed load or live-chain publication.

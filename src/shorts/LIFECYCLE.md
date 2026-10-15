# Hosted publication and storage recovery

The enabled hosted Shorts module uses `ShortsHostedHostingService` and PostgreSQL
`shorts_lifecycle_jobs` to resume maintenance after a restart. Run the normal API
migrations before starting it, including `ShortsMediaAdmission1791763225000`.
Startup refuses a schema without the `capacity_wait` result. No additional service
is needed: media admission uses the existing shared Redis connection. Its optional
`SHORTS_SHARED_CONCURRENT_MEDIA` setting defaults to two transfers. This adapter requires the shared metadata repository, the separate
publisher connection and verified moderation; demo auto-approval is rejected.

The loopback development entrypoint retains its local reconciler. The hosted API
still requires one API process pending deployed ingress and capacity validation.
Durable maintenance claims do not remove that deployment restriction or the
shared retained-upload budget.

## How work is scheduled

The content migration backfills existing records. A database trigger schedules a
job in the same transaction as new content and relevant publication or moderation
changes. A changed policy advances the job generation and invalidates an old
claim. Unrelated report-count updates do not restart maintenance.

Hosted review, report and appeal requests apply atomic metadata changes outside
the local snapshot queue, so an active manual scan cannot delay them. Scan
generations and the current moderation state prevent stale results from replacing
new decisions. Lifecycle and manual scanning have independent scheduling but use
the same [media transfer admission](RATE-LIMITS.md#shared-media-transfers).
Complete deployment-wide scan/publication capacity validation before scaling APIs.

For hosted publication, the creator's request only commits `publication=pending`.
That same database transaction schedules this worker; it returns `202` with
`publicationRequest=preparing` without waiting for storage or node IO. Repeating
the request preserves the existing job generation, lease and backoff. Status
reads remain available during storage/node outages while preparation is pending.
This acknowledgement is not publication or playback permission.

Each pass processes at most ten jobs, one at a time, without enumerating the
library or all IPFS pins. Passes run every 15 seconds and never overlap within a
process. Each attempt has a three-minute work deadline, including claim acquisition.
Hosted maintenance does not enter the local-demo mutation queue; database claims
and locked metadata updates protect its work. A claim has a two-minute lease, renewed
every 30 seconds and before external effects. Renewals coalesce into one operation;
their local expiry is measured conservatively from before the SQL request. A late
renewal cannot revive an expired attempt. An interrupted claim is available again after its lease expires;
an old generation or lease cannot acknowledge replacement work. Normal completed
checks recur after five minutes. Pending publication checks recur after 15 seconds.
Failures back off from ten seconds to five minutes. Busy or unavailable media
admission, a lost media permit and temporary scanner backpressure record
`capacity_wait`, preserve the existing failure count and retry after 15 seconds.
They do not create a moderation verdict. Ordinary storage/integrity failures
still use failure backoff.

Upgrade all API instances together after applying the migration. A downgrade of
this migration refuses to proceed while `capacity_wait` rows exist; it never
rewrites saved work to force compatibility.

These are scheduling intervals, not completion guarantees. Node, storage or
moderation outages can delay work. Capacity and upstream service limits still
apply. Shutdown stops new claims and waits for current work.

## What recovery does

- **Private drafts:** never published automatically. Missing or failed inspections
  can be retried; a successful scan alone does not grant content approval. A retry
  scans the already-quarantined source before changing metadata, so it does not
  invalidate its own lease. The final locked update rejects a cancelled attempt or
  any changed record, including a newer scan/review. Rejected or withdrawn records
  are not automatically rescanned. Accepted evidence schedules a fresh maintenance
  generation; it does not grant publication approval.
- **Publication requested:** consult the durable publication journal first. A
  request without a journal entry checks the signing queue's operator and creator
  limits before reading private media or uploading to IPFS. A paused or full queue
  keeps the request pending for the normal 15-second retry. This check does not
  reserve a slot: final enqueue still enforces the limits atomically. Unknown
  capacity fails closed and uses the failure backoff.
  When capacity is available, the worker pins and verifies the approved package under
  the lifecycle lease, then checks that lease and the current content policy again
  before enqueueing the separate signer. Storage failures keep the creator's saved
  intent pending and use the existing retry backoff. No browser needs to stay open.
  A lost enqueue acknowledgement is recovered by reading the journal, without
  uploading again or creating a replacement transaction. If an earlier attempt
  finished pinning but could not enqueue, retry first checks the actual recursive
  pin and verifies every expected file's length and hash. It reuses that verified
  package without rereading private storage or adding it again. Missing pins use
  the usual upload path; ambiguous pin reads or failed integrity checks remain
  failures, never permission to overwrite or unpin. A
  queued or signed request keeps its existing identity; the API does not repeatedly
  pin or sign it. Confirmed or reconciled requests update shared publication state
  and enqueue streaming preparation.
- **Published content:** check the canonical registry identity, current approval
  and one package's recursive pin. Rebuild a missing approved package from its
  verified private source. The pin response is capped at 16 KiB with a ten-second
  deadline; ambiguous IPFS failures are retried as failures, never treated as an
  absent pin.
- **Uncertain or conflicting publication:** do not create a replacement signature.
  A missing published registry record, or a cancelled/reverted publication request,
  is recorded as `reconciliation_required`. A conflicting registry identity is a
  failed check.
- **Withdrawn content:** record `retention_pending`. This hosted repair worker does
  not delete private objects or remove pins. Official delivery remains subject to
  current approval and withdrawal checks.

The publisher owns transaction signing. The MDW Shorts plugin remains responsible
for chain indexing; maintenance adds no transaction listener. Streaming preparation
uses its own [durable outbox](STREAMING-OUTBOX.md).

Shutdown, lost/expired leases and the work deadline cancel active node, private-source,
IPFS and inspection requests. Started work drains; if one package read fails,
sibling reads are cancelled and awaited before releasing admission. Interrupted jobs
remain recoverable after their lease expires; unfinished work is never marked checked.
API node reads retain a 20-second operation deadline, an eight-second per-request
deadline and bounded admission. SQL already in progress has its own
[database deadlines](DATABASE.md) and may have committed before cancellation.
This is not a hard whole-process shutdown deadline. A remote pin or publication
request already accepted cannot be recalled; recovery checks its existing identity.
Never unpin on cancellation without the retention workflow's reference checks.

## Monitoring

`GET /api/shorts/operator/lifecycle` requires operator authentication and returns
`Cache-Control: no-store`. It reports deployment-scoped counts (`total`, `active`,
`due`, `failed`, `capacityWaiting`, `retentionPending`, `reconciliationRequired`),
`oldestDueSeconds` and `lastCheckedAt`, without content IDs or creator addresses.
The local demo returns 503 for this hosted-only endpoint. Read failures do not
fall back to an empty or healthy queue.

Alert on increasing overdue age, repeated failures or reconciliation work. A
recent successful check does not prove that every job is healthy. `checked`
means maintenance completed for that record; it does not imply that the video
is approved, published or playable. Keep database access separate from the
restricted media-worker and publisher logins.

## Retention boundary

This worker repairs availability; it does not implement retention authorization.
Rejected media, withdrawn packages and abandoned private objects still require a
separate, reference-aware retention workflow. Do not replace that workflow with
bucket-wide expiration or an IPFS unpin sweep: shared content, live jobs, appeals
and lawful holds may still reference those bytes. Retained objects consume space
until that workflow is configured and run. See [private storage](PRIVATE-STORAGE.md)
for the provider and encryption requirements.

Removing a pin or deleting an original cannot erase copies held by third parties.

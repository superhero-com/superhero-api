# Private object version cleanup

This operations-only NestJS process removes a verified noncurrent encrypted
object version while retaining a current version with identical plaintext. It
never deletes a key, delete marker, unversioned `null` object, canonical IPFS
file, or HLS pin. Unreferenced objects, distinct historical bytes, incomplete
multipart uploads and IPFS block garbage collection need separate lifecycle
policies. No API route or background scheduler starts this process.

## Prerequisites

- Apply migrations through `1793232008001-ShortsPrivateMediaCleanup` and build
  the API. Use the existing enabled testnet deployment configuration from
  [storage reconciliation](STORAGE-REFERENCES.md).
- Keep bucket versioning enabled. Automatic lifecycle rules must be disabled;
  the command rejects any enabled rule, including rules on other prefixes.
  Restrict other principals to the existing create-only writes and reads. Do not
  grant ordinary API/media workers deletion or version-mutation permissions.
  Disable external cleanup automation on this managed bucket. Administrative
  bucket-policy changes and direct data repair require coordinated maintenance.
- For Amazon S3, use a dedicated cleanup identity with `GetObject`, `GetObjectVersion` and
  `DeleteObjectVersion` on only the configured deployment prefix, plus
  `GetBucketVersioning`, `GetLifecycleConfiguration` and `ListBucket` on its bucket.
  This follows the [S3 operation-to-permission mapping](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html#object-operations).
  Never grant unconditional `DeleteObject`, writes, versioning/lifecycle administration
  or governance retention bypass. Compatible providers must enforce equivalent
  version-only authority; see [provider compatibility tests](#provider-compatibility-tests).
  Provider Object Lock/retention restrictions remain effective.
  S3 needs [bucket-list permission to distinguish a missing object from access
  denial](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html).
  The coordinator probes missing-version visibility before issuing a deletion.
  Use a dedicated managed bucket where bucket metadata must be isolated.
  Verify these permissions against the actual provider before enabling cleanup;
  configuration and a protocol fixture cannot establish IAM enforcement.
- Mount the existing encryption key ring and owner-only credential files. The
  process rejects ambient AWS, signing, IPFS, streaming and moderation credentials.
  Use synchronized clocks. SQL grant time and process time must agree within
  five seconds; deletion URLs expire thirty seconds after that SQL timestamp.

Use a new restricted SQL login with no ownership, role membership, schema-create,
replication, superuser or bypass-RLS privileges. Grant SELECT on the source and
inventory tables listed in `STORAGE-REFERENCES.md`, plus
`shorts_private_storage_epochs`. Grant only SELECT and INSERT on
`shorts_private_version_cleanup` and `shorts_private_version_events`.
Do not grant inventory/history updates to this cleanup login. Keep the existing
reference-scanning login separate. Startup verifies these privileges and the
source change guards.

## Inspect, remove and recover

Finish a physical inventory and a **new** reference scan after applying the
migration. Earlier scans have no change-counter binding and cannot authorize
cleanup. Changes to logical references, upload state, processing state, appeals,
reports or holds invalidate the scan for cleanup. Ordinary view/like counters do
not. This conservative first implementation requires a reference scan with no
relevant changes during traversal; it does not pause creator uploads to get one.

Use an owner-only request file:

```json
{"id":"<new operation UUID>","scan":"<completed reference scan UUID>","identity":"<physical object identity>"}
```

Set `SHORTS_PRIVATE_VERSION_CLEANUP_ENABLED=true` in the dedicated process's clean
configuration only after the provider and release gates pass; the default is
false. The remaining settings are those of `storage-reconciliation.env.example`.

```sh
node --env-file=/secure/private-version-cleanup.env dist/shorts/private-version-cleanup-main reclaim /secure/request.json
```

The coordinator reserves the object in SQL, authenticates both immutable
versions without accumulating plaintext, and records each dispatch before
issuing its expiring version-specific deletion. It rechecks the change counter
immediately before sending. Active preparation/uploads, holds, pending appeals,
reports without disposition and withdrawn content prevent admission. A newly
committed hold stops a later dispatch check; an already-authorized storage request
may finish within its validity window. The verified current copy remains intact.

Success requires the deleted version to be absent and the retained version to
remain current. An absent, corrupted or changed retained copy fails verification.
A disconnected caller or uncertain storage response leaves the reservation and
append-only attempt history in place, even after process restart. Do not infer
failure from a timeout or retry under a different operation ID.

Use `{"id":"<operation UUID>"}` for these commands:

```sh
node --env-file=/secure/private-version-cleanup.env dist/shorts/private-version-cleanup-main status /secure/operation.json
node --env-file=/secure/private-version-cleanup.env dist/shorts/private-version-cleanup-main recover /secure/operation.json
node --env-file=/secure/private-version-cleanup.env dist/shorts/private-version-cleanup-main cancel /secure/operation.json
```

`recover` reauthenticates the retained bytes and records absence without sending
another deletion. If the candidate still exists, fix the cause, obtain a fresh
reference scan, and run `reclaim` with the **same operation ID and physical
identity**. A new dispatch cannot start within thirty seconds of the previous
one, and every attempt remains in history. `cancel` releases a reservation only
before any dispatch was issued. Status, recovery and unused-reservation
cancellation remain available with the deletion flag disabled. Used migration
history cannot be removed by rollback.

Keep command outputs private: they contain storage identifiers and operation
history. This is version deduplication, not proof that all temporary video storage
has been reclaimed. It does not change published CIDs, engagement or original
content.

## Provider compatibility tests

`npm run test:shorts:private-version-provider` runs the SQL/coordinator checks.
To also exercise actual storage, supply a disposable loopback PostgreSQL URL
(`SHORTS_TEST_PG_URL`), MinIO endpoint (`SHORTS_TEST_S3_ENDPOINT`), fixture-only
root credentials (`SHORTS_TEST_S3_ACCESS_KEY`, `SHORTS_TEST_S3_SECRET_KEY`) and
`SHORTS_TEST_MINIO_STS=1`. The private-storage CI job builds the pinned MinIO
fixture and runs these checks with a separate restricted temporary principal.
Fixtures remove their randomly named bucket, object versions, SQL schema and
role. Temporary credentials and encryption keys stay local to the test.

The checks cover authenticated duplicate comparison, exact-version removal,
retention holds, denied ordinary writes/deletes, denied retained-version removal,
expired and altered signatures, lost replies and a worker process exiting after
storage deletion but before its completion journal entry. Inventory and reference
scans use the actual provider listings and PostgreSQL guards.

IAM action and condition names differ across S3-compatible implementations.
The MinIO fixture requires `DeleteObject` with its `s3:versionid` condition;
the temporary grant lists only the exact historical version IDs on one object.
It grants no unconditional key deletion and excludes the current version and
`null`. Do not copy this MinIO policy to another provider or grant broad
`DeleteObject` to bypass an authorization failure. Production cleanup still
requires qualification of that provider's permissions, retention controls and
clock behavior; a local compatibility test does not authorize enabling it.

## Delegated integrity checks

Storage reconciliation, duplicate cleanup and retired-input cleanup can ask
the Shorts media service to authenticate immutable object versions. Configure
`SHORTS_VERSION_READBACK_URL` with the private HTTPS origin and
`SHORTS_VERSION_READBACK_KEY_FILE` with the absolute path to the dedicated
version verification credential in each participating maintenance process.
The media service must use the same release and storage identity, its scoped
version reader and the matching credential. The coordinator verifies a new
signed receipt for each check and retains its own retention, journal, provider
and dispatch checks before removal. An unavailable verifier stops the operation.
To restore local verification, remove both settings and restart the process
with its existing storage read access.

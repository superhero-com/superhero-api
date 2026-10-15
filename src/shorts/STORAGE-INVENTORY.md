# Private storage inventory

This separate NestJS command records the private S3 objects in a deployment's
namespace. It includes keys with no database record, older versions and delete
markers. Scans have a caller-supplied UUID and durable PostgreSQL checkpoints.
Restarting the process can resume the same run without counting saved pages twice.

It lists metadata only. It has no object read/write/delete operations, encryption
keys, media-service credentials or signing key. It does not start the public API.
The command is currently limited to enabled testnet deployments.

## Setup

1. Apply API migrations through `1791763217000-ShortsStorageInventory` with the
   migration owner. Build the API image/code with `npm run build`.
2. Provision a separate S3 identity with **`s3:ListBucketVersions`** restricted
   to the private bucket and deployment prefix. Do not grant object reads,
   writes, deletion, bucket administration or access to other deployments.
   This operation includes versions and delete markers; directory buckets are
   unsupported. See [S3 ListObjectVersions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectVersions.html).
   An S3-compatible provider must support the same pagination semantics.
   Test its actual permission enforcement; an emulator cannot prove IAM policy.
3. Create a separate database login with no role memberships, schema creation,
   superuser, replication, bypass-RLS or object-ownership privileges. Example
   grants for `public` (adjust schema names as needed):

   ```sql
   CREATE ROLE shorts_storage_inventory LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
     NOINHERIT NOREPLICATION NOBYPASSRLS;
   GRANT USAGE ON SCHEMA public TO shorts_storage_inventory;
   GRANT SELECT ON public.shorts_runtime TO shorts_storage_inventory;
   GRANT SELECT, INSERT, UPDATE ON public.shorts_storage_inventory_runs
     TO shorts_storage_inventory;
   GRANT SELECT, INSERT ON public.shorts_storage_inventory_pages,
     public.shorts_storage_inventory_objects TO shorts_storage_inventory;
   ```

   Set the password through your secret manager/database workflow. Source rows
   are read-only; inventory object/page evidence is append-only for this login.
   Role checks reject excessive source writes, column/table evidence updates,
   destructive grants or row-level-security filtering on these tables. Also
   review inherited PUBLIC grants. The account can operate across deployments
   in its schema; it is not a creator account or per-deployment SQL boundary.
4. Copy `storage-inventory.env.example` to an owner-only file outside Git. Use
   the same manifest, endpoint, region, bucket, addressing mode and prefix as
   private upload storage, but the new listing-only credential file. Its JSON
   shape is documented in [PRIVATE-STORAGE.md](PRIVATE-STORAGE.md). No encryption
   key ring is needed. The process deliberately ignores the API `.env`.
5. Run from a clean service environment. Known encryption, signing, media-service
   and ambient AWS credentials cause startup rejection. Use private encrypted
   PostgreSQL transport, HTTPS S3, connection/resource limits and restricted
   network access in the deployment. The command cannot validate provider IAM
   or protect against an administrator changing storage outside the platform.

The namespace is `prefix/sha256(JSON.stringify([network,contract]))/`. A `start`
result includes `objectPrefix` and `storageId`. Starting a run does not list S3.
The storage identity binds the endpoint, region, bucket, prefix and addressing
mode. Changing those settings requires a new run; credential rotation does not.

## Run and resume

Create an owner-only JSON request file containing a new UUID:

```json
{"id":"<new UUID>"}
```

Then run:

```sh
node --env-file=/secure/storage-inventory.env dist/shorts/storage-inventory-main start /secure/run.json
node --env-file=/secure/storage-inventory.env dist/shorts/storage-inventory-main scan /secure/run.json
node --env-file=/secure/storage-inventory.env dist/shorts/storage-inventory-main status /secure/run.json
```

`scan` advances up to 10 pages by default, with 100 entries per S3 page. Set
`"pages":1`–`100` in its request to change the invocation budget. Each invocation
has a two-minute work budget; each page has its own S3/SQL deadlines. If a budget
expires, the command fails and preserves already committed pages. Read `status`,
then run `scan` again with the same UUID until `listingComplete` is true.

Each page's rows, exact counters and continuation cursor commit together. IO runs
outside SQL transactions. A concurrent stale attempt fails and cannot double-count
or overwrite a checkpoint. An uncertain commit must be resolved by `status`, not by
assuming the page failed. Calling `scan` on a completed run makes no further S3
request. A changed observation or repeated cursor fails; preserve that run and
start a new UUID to re-inventory changing storage.

For a bounded listing of saved observations, use `objects`:

```json
{"id":"<run UUID>","limit":100}
```

```sh
node --env-file=/secure/storage-inventory.env dist/shorts/storage-inventory-main objects /secure/objects.json
```

Put the result's `next` value in `after` for the next page. A null `next` ends the
pass. These pages are ordered by observation identity, not key or creation date.
Requests allow at most 100 observations. Protect outputs as internal metadata.

## What the totals mean

Counts and byte totals are decimal strings to preserve exact values. They are
updated from newly inserted observations in the same transaction as each page;
status reads do not rescan the whole inventory.

| Field | Meaning |
|---|---|
| `entries` | Observed key/version/delete-marker identities |
| `deleteMarkers` | Observed delete markers, including noncurrent markers |
| `storedBytes` | Sum of stored object-version sizes returned by S3 |
| `currentBytes` | Sum of object versions reported as latest when observed |
| `listingComplete` | The provider returned the end of this listing traversal |
| `referenceReconciliationComplete` | Always false for the physical listing; use a separate reference scan |
| `deletionEnabled` | Always false |

Stored sizes include encryption envelopes for encrypted objects. They are not a
storage invoice: delete-marker overhead, multipart uploads, provider replication,
metadata and minimum storage charges are not included. Data can change during a
multi-page scan, so completion is not a point-in-time snapshot or proof that no
new object exists behind an earlier cursor. Keep completed runs to compare growth
and repeat scans on the agreed operating schedule.

## Cleanup boundary

An unrecorded key is an observation, not a deletion candidate. It may belong to
an in-flight upload or an encrypted source manifest whose parts are absent from
SQL. This command does not decrypt/expand manifests, reconcile
[logical references and holds](RETENTION.md), inventory derived HLS/backups or
enforce retention periods. Those remain prerequisites for destructive cleanup,
along with writer coordination and final reference/hold checks. Do not enable
bucket expiration or derive a bulk-delete list from these rows.

After listing completes, [storage reference reconciliation](STORAGE-REFERENCES.md)
can expand manifests and match the observations to logical references and holds.
It runs with separate read/decryption credentials and still never authorizes
deletion. Its `referenceTraversalComplete` is independent of this listing's status.

Inventory history pruning is not automatic. Migration rollback refuses to drop
used inventory tables. History retention, backup and capacity need an agreed
operations policy; ordinary API/worker identities must not be granted access to
these tables or listing credentials.

For unfinished provider-side multipart uploads, use the optional
[multipart inventory](MULTIPART-INVENTORY.md) with a separate metadata credential.
It reuses this module and environment shape without expanding this command's grants.


## Provider compatibility

Qualify multipart prefix listing against the actual storage provider before using
its report as evidence of completeness. A successful HTTP response with no entries
is not sufficient proof. MinIO `RELEASE.2025-09-07T16-13-09Z` treats a nonempty
multipart `Prefix` as an exact object key, so a deployment-prefix query can return
empty while uploads exist underneath it. Its
[implementation](https://github.com/minio/minio/blob/07c3a429bfed433e49018cb0f78a52145d4bedeb/cmd/erasure-multipart.go)
documents that limitation. Listing known object keys individually cannot discover
unknown unfinished uploads and does not qualify prefix inventory. This inventory does not silently fall back to a
bucket-wide scan or broaden its listing credentials. Multipart completeness on
such a provider is unverified; keep deletion and abort automation disabled.

The opt-in multipart integration test creates uploads both inside and outside the
deployment prefix and verifies pagination and exact totals. A provider that fails
that test is not qualified for multipart inventory, even if ordinary object reads,
writes and version listing pass. Version-list continuation markers are opaque and
must be returned unchanged, including provider-specific suffixes.

# Optional S3 multipart inventory

The Shorts uploader stores encrypted chunks using ordinary S3 `PutObject` calls.
Those objects are covered by [storage inventory](STORAGE-INVENTORY.md). This
optional command audits unfinished **provider-side multipart uploads**, which
other tools or migrations may leave in the bucket. It does not change uploading.

The command runs inside the existing NestJS storage-inventory module. It lists
upload and part metadata, saves resumable PostgreSQL checkpoints, and never reads
media, completes uploads, aborts uploads or deletes objects. It is currently
limited to enabled testnet deployments.

## Setup

1. Apply migrations through `1791763221000-ShortsMultipartInventory` with the
   migration owner, then build with `npm run build`.
2. Provision a separate operations credential with `s3:ListBucketMultipartUploads`
   for the private bucket and `s3:ListMultipartUploadParts` for its deployment
   object namespace. Treat upload-listing permission as bucket-wide metadata
   access: this command's prefix filter is not an IAM boundary. Use a dedicated
   bucket if deployments must not expose their metadata to this operations role.
   Do not expand the API/worker identities or existing version-listing identity.
   Do not grant object reads/writes, completion, abort, deletion or administration.
   Validate permissions against the actual provider, including denied operations.
3. Create a restricted PostgreSQL login with no role memberships, schema creation,
   object ownership, superuser, replication or bypass-RLS privileges. For example:

   ```sql
   CREATE ROLE shorts_multipart_inventory LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
     NOINHERIT NOREPLICATION NOBYPASSRLS;
   GRANT USAGE ON SCHEMA public TO shorts_multipart_inventory;
   GRANT SELECT ON public.shorts_runtime TO shorts_multipart_inventory;
   GRANT SELECT, INSERT, UPDATE ON public.shorts_multipart_inventory_runs
     TO shorts_multipart_inventory;
   GRANT SELECT, INSERT ON public.shorts_multipart_inventory_uploads,
     public.shorts_multipart_inventory_parts, public.shorts_multipart_inventory_outcomes,
     public.shorts_multipart_inventory_pages TO shorts_multipart_inventory;
   ```

   Set its password through your normal secret-management workflow. Review PUBLIC
   grants too. Role checks reject source writes, evidence updates, destructive
   privileges and RLS filtering. This login operates across deployments in its
   schema; it is not a per-creator or per-deployment SQL boundary.
4. Copy `storage-inventory.env.example` to a private, owner-only environment file.
   Set `DB_USER`/`DB_PASSWORD` to the new login and
   `SHORTS_PRIVATE_S3_CREDENTIALS_FILE` to its separate credential JSON. Keep the
   upload storage's manifest, endpoint, region, bucket, prefix and addressing mode.
   No encryption, signing, IPFS or other media-service keys are needed. Start from
   a clean environment; the process ignores the API `.env`. Use private encrypted
   SQL transport and HTTPS S3 with restricted network access.

General-purpose S3 pagination semantics are required; directory buckets are
unsupported. See [ListMultipartUploads](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListMultipartUploads.html).
For SSE-KMS/DSSE-KMS uploads, AWS also requires `kms:Decrypt` to list parts. Do not
automatically add KMS authority to this metadata role: have the storage owner
review that separate requirement, or leave the affected audit incomplete.
[ListParts permissions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListParts.html).

## Run and resume

Save an owner-only request file with a new UUID:

```json
{"id":"<new UUID>"}
```

```sh
node --env-file=/secure/multipart-inventory.env dist/shorts/storage-inventory-main multipart-start /secure/run.json
node --env-file=/secure/multipart-inventory.env dist/shorts/storage-inventory-main multipart-scan /secure/run.json
node --env-file=/secure/multipart-inventory.env dist/shorts/storage-inventory-main multipart-status /secure/run.json
```

The scan first lists uploads, then visits their part lists. It saves at most 100
observations per provider page. A scan invocation advances 10 steps by default;
add `"pages":1`–`100` to set its budget. A step can list uploads, list parts or mark
the traversal complete. Invocations have a two-minute work budget and bounded
S3/SQL deadlines. Inspect status after interruption and resume the same UUID.
Only committed pages count; concurrent stale attempts cannot overwrite progress.
If the provider changes an already saved observation or repeats a cursor, preserve
the incomplete run and start a new UUID. Completed runs make no further S3 calls.

Use `multipart-uploads` with `{"id":"<run UUID>","limit":100}` to page saved
uploads. Put its `next` identity in `after` for the following page. Use
`multipart-parts` with `{"id":"<run UUID>","upload":"<upload identity>","limit":100}`
to page a saved upload's parts; its `after` cursor is a part number. Both commands
take the same environment file and request-file argument as the commands above.
Protect outputs as internal metadata, including object keys and upload IDs.

## Interpret the result

Counters and byte totals are decimal strings. `observedPartBytes` sums saved
part-size observations; it is neither current billable storage nor a snapshot.
`listingComplete` means both provider-reported traversals ended.
`allListedUploadsObserved` means every **listed** upload returned a complete part
traversal without an explicit disappearance; it can be true for an empty list.
It replaces the former `allUploadsObserved` field. Neither field establishes that
the provider returned every upload or detects uploads or parts created behind a
cursor during the scan. `inventoryCompleteness` is always `"unverified"`:
zero uploads means zero reported uploads, not proof the bucket is empty.
`consistentSnapshot` and `deletionEnabled` are always false.

Qualify the actual provider's scoped pagination before relying on this audit;
see [provider compatibility](STORAGE-INVENTORY.md#provider-compatibility).
Provider qualification does not turn a live traversal into a consistent snapshot.

An explicit provider `404 NoSuchUpload` records the upload as `unavailable`.
Previously observed parts remain in the historical totals. Permission errors,
timeouts and ambiguous failures stop the scan without advancing its checkpoint.
An empty observed upload and an unavailable upload are distinct outcomes.

Every saved upload has `eligibleForAbort:false`. Age, lack of a database record,
or a completed traversal does not establish abandonment. Retention policy, active
writer coordination and a final live check are required before a separate cleanup
mechanism could act. No lifecycle rules or abort permissions are installed here.
History pruning is not automatic; used migration history cannot be rolled back.

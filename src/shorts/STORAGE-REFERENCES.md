# Reconcile private storage references

This operations command matches a completed [S3 inventory](STORAGE-INVENTORY.md)
against upload records, prepared media and [retention holds](RETENTION.md). It
decrypts source manifests to recover references to parts absent from SQL, including
legacy imports. It does not download source video parts or rendered video files.

Source references carry their saved processing profile and accepted byte limit
through manifest inspection and snapshot comparison. This permits the 96 parts of
a 100,000,000-byte original while keeping legacy and smaller accepted limits in
force. Two claims for the same manifest with different saved policies are
validated separately; a policy change during inspection invalidates the scan
step before any reference rows are committed.

After `ShortsPrivateInputRetirement` has recorded an authenticated source manifest,
scans can recover its part references from that immutable database receipt. They
recheck its complete byte length and SHA-256 against each current source claim,
then validate the document identity, chunk sequence, scope and frozen upload limit.
This permits traversal after the encrypted manifest is removed. It does not drop
any object references or override holds, and it does not authorize removal. A
mismatched receipt fails the scan; the scanner does not silently omit its parts.
Receipts apply only to original-format uploads. Unretired and legacy sources
continue to require their authenticated encrypted manifest reads.

It writes resumable reference evidence to PostgreSQL. It never changes S3,
publishes media, releases holds or deletes anything. It is a separate NestJS
entrypoint in the API repository, currently restricted to enabled testnet
deployments. The ordinary API and workers do not start it.

## Setup

1. Apply migrations through `1793145606000-ShortsDeliveryStaging`, then build
   with `npm run build`. Finish a storage inventory for this exact deployment,
   endpoint, region, bucket, prefix and addressing mode.
   Original-media outputs are matched to their declared file name, size and hash
   before accepting references up to 100,000,000 bytes. Legacy outputs retain the
   64 MiB ceiling. Reference inspection reads metadata, not the large media files.
2. Give the command a separate S3 identity with **GetObject only** on the private
   deployment prefix. Do not grant listing, writes, deletion or bucket management.
   Mount the private-media encryption key ring, including keys still referenced
   by older media. Use owner-only credential/key JSON files as described in
   [PRIVATE-STORAGE.md](PRIVATE-STORAGE.md). Test actual provider IAM enforcement;
   the command cannot establish that from an emulator or configuration alone.
3. Create a restricted database login with no role memberships, object ownership,
   schema creation, replication, superuser or bypass-RLS privileges. Example grants
   for the `public` schema:

   ```sql
   CREATE ROLE shorts_storage_reconciliation LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
     NOINHERIT NOREPLICATION NOBYPASSRLS;
   GRANT USAGE ON SCHEMA public TO shorts_storage_reconciliation;
   GRANT SELECT ON public.shorts_runtime, public.shorts_content,
     public.shorts_ingestion, public.shorts_upload_sessions, public.shorts_delivery_packages, public.shorts_delivery_generations, public.shorts_delivery_staging, public.shorts_upload_parts,
     public.shorts_retention_holds, public.shorts_storage_inventory_runs,
     public.shorts_storage_inventory_objects TO shorts_storage_reconciliation;
   GRANT SELECT, INSERT, UPDATE ON public.shorts_storage_reconciliations
     TO shorts_storage_reconciliation;
   GRANT SELECT, INSERT ON public.shorts_storage_reference_roots,
     public.shorts_storage_references TO shorts_storage_reconciliation;
   ```

   If migration `1793491200000-ShortsPrivateInputRetirement` is installed, also
   grant SELECT on `shorts_private_input_retirements`. The source reader verifies
   that access is complete and read-only; it rejects even column-level writes.
   Older schemas without the retirement table keep the encrypted-manifest path.

   Set its password through your secret manager. The command rejects source or
   hold write permissions, filtered tables, mutable reference rows and destructive
   grants. Review PUBLIC grants too. This login is an operations role across
   deployments in the schema, not a creator-level SQL boundary.
4. Copy `storage-reconciliation.env.example` into your secret/configuration system.
   Run in a clean environment with private encrypted SQL transport, HTTPS S3 and
   resource/network limits. API `.env` files are ignored. Signing, media-service
   and ambient AWS credentials are rejected. No IPFS/streaming keys are needed.

## Run and resume

Create an owner-only JSON request containing a new scan UUID and the completed
physical inventory UUID:

```json
{"id":"<new scan UUID>","inventoryId":"<completed inventory UUID>"}
```

```sh
node --env-file=/secure/storage-reconciliation.env dist/shorts/storage-reconciliation-main start /secure/start.json
```

Use a second request with `{"id":"<scan UUID>"}` for scanning and status:

```sh
node --env-file=/secure/storage-reconciliation.env dist/shorts/storage-reconciliation-main scan /secure/scan.json
node --env-file=/secure/storage-reconciliation.env dist/shorts/storage-reconciliation-main status /secure/scan.json
```

Each scan invocation visits up to 10 roots by default (`pages`: 1–100), within a
two-minute work budget. Each root has a one-minute budget, at most 256 references,
and source manifests at most 96 KiB. SQL has its own deadlines. A failed, cancelled
or stale concurrent attempt cannot partially advance a root. Read status after an
interruption or uncertain response, then resume the same ID. Invalid/missing
manifests and unknown encryption keys stop progress; investigate and repair the
source rather than skipping it. Completed runs make no further S3 requests.

After `referenceTraversalComplete` is true, inspect either direction:

```sh
node --env-file=/secure/storage-reconciliation.env dist/shorts/storage-reconciliation-main objects /secure/page.json
node --env-file=/secure/storage-reconciliation.env dist/shorts/storage-reconciliation-main references /secure/page.json
```

The page request is `{"id":"<scan UUID>","limit":100}`. Put the returned `next`
in `after` for subsequent pages; null ends the pass. Cursors differ between the
two commands. Keep outputs private: they contain storage identifiers and hold
metadata.

- `objects` classifies each physical version/delete-marker observation as held,
  referenced or unresolved. Shared keys retain every referencing root. Active
  holds also cover otherwise unreferenced keys under that resource's namespace.
- `references` checks for latest physical observations for each logical reference:
  observed, not observed, delete marker, size mismatch or conflicting latest
  observations. Size comparison includes the 36-byte encryption envelope. It
  does not verify the content/checksum of video parts or rendered files.

## Verify an older object's bytes

The optional `verify-versions` action inspects one noncurrent, non-delete-marker
observation after the reference scan completes. Give its dedicated S3 reader
`GetObjectVersion` in addition to `GetObject` on the same deployment prefix.
No deletion, listing or write permissions are needed.

```json
{"id":"<completed scan UUID>","identity":"<identity from the objects page>"}
```

```sh
node --env-file=/secure/storage-reconciliation.env dist/shorts/storage-reconciliation-main verify-versions /secure/version.json
```

The action requires one consistent logical content identity and matching stored
length. It identifies the current immutable version, then streams that version
and the candidate sequentially. Each read must return the requested version and
pass full AES-GCM authentication, plaintext length and SHA-256 verification.
The current version is checked again after both reads. Missing versions, changed
current pointers, delete markers and unversioned `null` IDs fail verification.
The operation shares the command's two-minute deadline and does not accumulate
plaintext in memory or create temporary media files.

The result identifies both verified versions and their byte counts. It reports
`retentionRechecked: false` and leaves deletion disabled: it is a point-in-time
content observation, not a permit to delete either version. Holds, references,
writers and current versions can still change afterward. A cleanup coordinator
must establish fresh policy and mutation authority independently. In particular,
[a version-specific S3 delete is permanent](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeletingObjectVersions.html);
a key-only delete and deletion of a delete marker have different effects.

## Limits

These are historical observations, **not a consistent snapshot**. Files, records
and holds can change during or after either scan. A manifest is read at its current
key, not a version frozen by the earlier physical inventory. Missing observations
can mean later writes, and matching size alone does not prove intact video bytes.
The command rechecks each root after manifest IO, but does not lock ongoing writers
or make later hold changes retroactive in saved results.

Every result keeps `deletionEnabled` and `eligibleForDeletion` false. Never turn
unresolved rows into a bulk-delete list. Cleanup still requires an agreed retention
policy, writer coordination, fresh reference/hold checks, and separate handling of
IPFS/HLS, incomplete multipart uploads, backups and inventory-history retention.
Used reconciliation history cannot be dropped by migration rollback.

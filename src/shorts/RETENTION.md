# Media references and retention holds

This operations command lists known media references and records holds that must
be considered before storage cleanup. It runs inside the API's NestJS codebase as
a separate process. It does not start the API, media worker or publisher.

**It does not delete anything.** Automatic retention is disabled. A database
reference report is not a complete storage inventory or permission to delete
objects. Do not configure bucket expiration or bulk IPFS unpinning from this report.

## Setup

1. Apply the normal API migrations through `1791763216000-ShortsRetentionHolds`
   using the migration owner. The command never runs migrations.
2. Have the DBA create a dedicated login. It must not own the schema/tables, have
   role memberships, schema creation rights, superuser or bypass-RLS privileges.
   Do not reuse the API, worker, publisher or migration login. Example grants for
   the `public` schema (adjust the schema if needed):

   ```sql
   CREATE ROLE shorts_retention LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
     NOINHERIT NOREPLICATION NOBYPASSRLS;
   GRANT USAGE ON SCHEMA public TO shorts_retention;
   GRANT SELECT ON public.shorts_runtime, public.shorts_content,
     public.shorts_ingestion, public.shorts_upload_sessions,
     public.shorts_upload_parts TO shorts_retention;
   GRANT SELECT, INSERT, UPDATE ON public.shorts_retention_holds TO shorts_retention;
   ```

   Set its password through the database/secret-management workflow. Ensure
   inherited `PUBLIC` grants do not allow schema creation or table writes. It
   needs unfiltered SELECT on the listed sources to count shared references;
   row-level-security filtering is rejected. The login can read sources and
   manage holds across the deployments in that schema. The command selects the
   deployment from its manifest; this is an operations account, not a creator
   session or a per-creator authorization boundary.
3. Copy `retention.env.example` to an owner-only file outside the repository.
   Set the database connection and public deployment manifest. The object prefix
   must match `SHORTS_PRIVATE_S3_PREFIX` on the API and workers. Use an encrypted
   private database transport appropriate to your deployment.
4. Build with `npm run build`. Launch from a clean service environment with only
   the retention settings. No storage/encryption/moderation/streaming/operator
   credentials belong in this process. Known service-secret variables are
   rejected; the process does not load the API's `.env` or any S3 client.

The command currently accepts enabled `ae_uat` deployments only. It validates the
complete versioned manifest described in [README.md](README.md#contract-release-identity)
and the database role before executing an operation. Use the same read-only manifest
as the API; a reduced contract/network/source-hash receipt is not accepted.
The dedicated Shorts database pool limits connection wait, SQL and transaction
duration; see [DATABASE.md](DATABASE.md).

## Commands

Each command takes one absolute JSON request-file path and emits one JSON result.
Protect these files and the output as internal operational data. Use internal case
identifiers, not report text or personal information, in a hold's `reference`.

```sh
node --env-file=/secure/retention.env dist/shorts/retention-main inventory /secure/page.json
node --env-file=/secure/retention.env dist/shorts/retention-main hold /secure/hold.json
node --env-file=/secure/retention.env dist/shorts/retention-main holds /secure/history.json
node --env-file=/secure/retention.env dist/shorts/retention-main release /secure/release.json
```

| Action | JSON request | Result |
|---|---|---|
| `inventory` | `{"limit":25}` | Known upload/content/job roots, object references, active hold counts and retention reasons |
| `hold` | `{"id":"<new UUID>","resourceId":"<video/upload ID>","reason":"legal","reference":"case-123"}` | Immutable hold identity, database login and timestamp |
| `holds` | `{"resourceId":"<video/upload ID>","limit":25}` | Hold history, including released entries |
| `release` | `{"id":"<hold UUID>"}` | Original hold plus release login and timestamp |

For the next inventory/history page, put the returned `next` value in `after`.
Pages default to 25 and allow at most 50 records. A null `next` ends that pass.
History is ordered by UUID, not creation time. Each inventory page reads a
consistent database snapshot; an entire multi-page pass is not an atomic
snapshot. Repeat passes when reconciling a changing library.

Reasons are `legal`, `safety`, `appeal` or `recovery`. A hold may cover a discovered
orphan upload ID that has no current content row. Creating the same UUID with the
same request is idempotent. Reusing it for another request fails. Releasing an
already released hold is idempotent, and repeating its create request does not
reactivate it: use a new UUID for a new hold. Keep hold IDs to resolve uncertain
command outcomes before retrying.

The database prevents editing hold identity, forging another login's actor,
releasing twice or deleting history through normal row operations. The restricted
login cannot truncate the table. DBA-level actions and backups still need their
normal access controls and audit. Migration rollback refuses to remove a table
with any hold history, including released holds.

## Interpreting the report

- `objects` lists known encrypted-source/manifest/prepared-output references.
  Repeated keys within one resource are counted once. `knownPlaintextBytes` is
  their declared plaintext size, not actual S3 usage or billable bytes. It omits
  encryption overhead, object versions and files absent from SQL.
- Source manifests may reference additional parts, especially after legacy
  migration. They are encrypted and this command has no decryption keys.
  `manifest-children-not-inventoried` makes that gap explicit.
- `cidReferences` counts content rows across all deployments in the same
  database schema, including withdrawn rows. It does not count another database,
  an independent IPFS pin or an external user of that CID.
- Active preparation/uploads, content/source references, pending appeals,
  reports without a recorded disposition and explicit holds are retained.
  An empty `retainReasons` array does **not** establish safe deletion.
- `completePhysicalInventory`, `eligibleForDeletion` and `deletionEnabled`
  remain false. Holds are durable records for a future cleanup coordinator;
  they cannot prevent an out-of-band administrator from deleting a bucket object.

A destructive retention worker requires an agreed retention policy, physical S3
and derived-HLS inventory, manifest expansion, crash-output reconciliation and
coordination with writers. It must recheck holds and shared references at the
deletion boundary and preserve required evidence/history. API and media-worker
credentials must remain unable to delete objects.

Use the separate [storage inventory command](STORAGE-INVENTORY.md) to observe
S3 versions, delete markers and keys absent from SQL. It does not expand encrypted
manifests or authorize deletion, and it uses its own listing-only credentials.
Then use [storage reference reconciliation](STORAGE-REFERENCES.md) with a separate
read identity to expand source manifests and match saved physical observations
against references and holds. Both commands produce historical evidence, not a
snapshot or permission to delete.

[HLS index inventory](HLS-INVENTORY.md) separately matches prepared streaming
metadata to source references and holds. Its byte counts describe indexed files,
not physical pins or disk usage, and do not authorize unpinning.

For physical IPFS observations, run [pin inventory](PIN-INVENTORY.md) with a
completed HLS inventory. This separate operations role cannot unpin or read media.

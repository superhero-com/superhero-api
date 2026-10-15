# HLS index inventory

This separate NestJS operations command records the streaming service's prepared
HLS index and matches it to API source references and retention holds. It can
identify indexed packages without current source records, source records without
an observed index, and packages shared by several indexes. A hold on any matched
source also marks the other indexes for that same HLS CID as held.

It reads metadata only: no video downloads, transcoding, publication, key signing
or storage deletion. It does not start the API or streaming workers. It is
currently limited to enabled testnet deployments.

## Setup

1. Apply API migrations through `1791763219000-ShortsHlsInventory`, then
   `npm run build`. Use the same deployment manifest as the API.
2. Create a dedicated Redis 7+ read account for the streaming namespace. For
   example, its ACL needs these permissions (supply its password privately):

   ```text
   on ~shorts-hls-v2:prepared:* -@all +ping +select +eval_ro +scan +strlen +pttl +get +info
   ```

   Adjust the namespace. Do not grant write commands, ordinary `EVAL`, queue
   management or administrative commands. The reader uses `EVAL_RO` to bound
   the metadata response before it leaves Redis. `INFO server` binds its cursor
   to the Redis process identity. `SCAN` and `INFO` expose database/server
   metadata; this is a trusted operations account, not a creator account.
   Test its actual ACL enforcement and restrict it to the private Redis service.
3. Create a separate PostgreSQL login, with no memberships, superuser, bypass-RLS,
   schema creation, object ownership, replication or role/database creation.
   Give it these grants, adjusted for your schema:

   ```sql
   GRANT USAGE ON SCHEMA public TO shorts_hls_inventory;
   GRANT SELECT ON public.shorts_runtime, public.shorts_content,
     public.shorts_ingestion, public.shorts_upload_sessions,
     public.shorts_upload_parts, public.shorts_retention_holds
     TO shorts_hls_inventory;
   GRANT SELECT, INSERT, UPDATE ON public.shorts_hls_inventory_runs
     TO shorts_hls_inventory;
   GRANT SELECT, INSERT ON public.shorts_hls_inventory_roots,
     public.shorts_hls_inventory_entries, public.shorts_hls_inventory_pages
     TO shorts_hls_inventory;
   ```

   Source/hold access must be unfiltered and read-only. Evidence rows are
   append-only for this login. Startup rejects excessive grants and RLS filtering;
   review PUBLIC grants too. Operations access spans deployments in the schema.
4. Copy `hls-inventory.env.example` to your configuration system outside Git.
   Match the streaming Redis endpoint/database and namespace exactly. Mount a
   separate owner-only password file (at most 4 KiB). Use Redis TLS and private
   encrypted PostgreSQL transport. No media or signing credentials are needed;
   known incompatible credentials cause startup rejection. API `.env` is ignored.

## Run

Create a private JSON file containing a new UUID:

```json
{"id":"<new run UUID>"}
```

```sh
node --env-file=/secure/hls-inventory.env dist/shorts/hls-inventory-main start /secure/run.json
node --env-file=/secure/hls-inventory.env dist/shorts/hls-inventory-main scan /secure/run.json
node --env-file=/secure/hls-inventory.env dist/shorts/hls-inventory-main status /secure/run.json
```

`scan` first saves logical roots in pages of 25, then scans the prepared Redis
keys. It runs up to 10 steps per invocation (`pages`: 1–100) within a two-minute
work budget. Run again with the same ID until `indexTraversalComplete` is true.
The phase, cursor, entries and byte counters commit together. Restarts and lost
responses can resume from `status`; concurrent stale attempts cannot double-count.

If Redis restarts, the storage identity changes, an index changes between
observations, a cursor repeats, or index data is invalid, the scan fails. Preserve
the evidence and investigate before starting a new run. Do not skip invalid keys
or classify them as garbage. Completed scans make no further Redis requests.

Inspect the two sides with bounded pages:

```sh
node --env-file=/secure/hls-inventory.env dist/shorts/hls-inventory-main entries /secure/page.json
node --env-file=/secure/hls-inventory.env dist/shorts/hls-inventory-main roots /secure/page.json
```

Use `{"id":"<run UUID>","limit":100}` and then pass the returned `next` as
`after`. Null ends the pass. Keep outputs private. `entries` includes package
files, byte counts, source-reference counts, shared-package counts and observed
holds. `roots` includes source identities, retain reasons and whether an index
was observed. Counters are decimal strings to preserve exact values.

## Interpretation and limits

Redis `SCAN` can repeat keys and return empty intermediate pages, and its count
is a hint. The command deduplicates observations and checks bounds inside Redis:
64 keys, 32 KiB per index and 256 KiB per response. See the
[Redis SCAN guarantees](https://redis.io/docs/latest/commands/scan/).

`indexedMediaBytes` sums recorded package files once per source key. Shared CIDs
can therefore be counted more than once. This is **not physical IPFS disk usage**,
a pin-presence check or a checksum verification of stored segments. Orphan pins
left before an index commit, block deduplication, DAG overhead, local caches,
scratch files and backups are not included. `physicalPinInventoryComplete` stays
false. Use the separate [IPFS pin inventory](PIN-INVENTORY.md) to compare this completed
run with physical pin observations and repository-size samples.

Source matching uses the streaming service's `hls-v2` identity: video ID, original
CID, original `video.mp4` SHA-256 and byte count. Older source versions no longer
in current API records stay unresolved. The command does not reverse a hash or
infer ownership. It reads all current roots, including withdrawn content and
hold-only records; it does not infer playback permission from the inventory.

The two passes are historical observations, not a consistent snapshot. Holds,
source versions and indexes can change between or after pages. Every result keeps
`eligibleForDeletion` and `deletionEnabled` false. Actual cleanup needs agreed
retention periods, live reference/hold checks, writer coordination and physical
pin accounting. Never unpin a CID merely because this report lacks a match.
History pruning is not automatic; migration rollback refuses used inventory tables.

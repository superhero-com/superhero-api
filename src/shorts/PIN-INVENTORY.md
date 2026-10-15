# IPFS pin and capacity inventory

A separate Nest operations command compares physical pins on one Kubo node with
original-video and HLS references from a completed [HLS inventory](HLS-INVENTORY.md).
It reports missing recursive pins, known references, observed holds and unmatched
pins. It never downloads video bytes, publishes, unpins or runs garbage collection.
It does not start the API, media workers or signer. Enabled testnet only.

## Configure

1. Apply API migrations through `1791763220000-ShortsPinInventory` and build with
   `npm run build`. Complete an HLS inventory for the same deployment first.
2. In `superhero-ipfs`, enable the distinct `IPFS_INVENTORY_TOKEN_FILE` credential
   and recreate Kubo and the TLS proxy. Fresh `make setup` installations include
   it; existing installations must add it explicitly. Its native Kubo grant is
   **only `pin/ls`, `repo/stat`, `id`**. Do not reuse the API/write or streaming key.
3. Use the private HTTPS endpoint for one node. Obtain its peer ID via authenticated
   `id`; verify it against the intended node and set `SHORTS_PIN_PEER_ID`. Do not
   point this tool at a load balancer spanning independent Kubo repositories.
   Mount the token file owner-only. The tool rejects redirects and remote plaintext
   HTTP; TLS verification stays enabled. Private CAs need `NODE_EXTRA_CA_CERTS`.
4. Create a PostgreSQL login without memberships, object ownership, schema CREATE,
   superuser, bypass-RLS, replication, role/database creation, or destructive grants:

   ```sql
   GRANT USAGE ON SCHEMA public TO shorts_pin_inventory;
   GRANT SELECT ON public.shorts_runtime, public.shorts_content,
     public.shorts_ingestion, public.shorts_upload_sessions,
     public.shorts_upload_parts, public.shorts_retention_holds,
     public.shorts_hls_inventory_runs, public.shorts_hls_inventory_roots,
     public.shorts_hls_inventory_entries TO shorts_pin_inventory;
   GRANT SELECT, INSERT, UPDATE ON public.shorts_pin_inventory_runs
     TO shorts_pin_inventory;
   GRANT SELECT, INSERT ON public.shorts_pin_inventory_entries
     TO shorts_pin_inventory;
   ```

   Adjust the schema. Startup checks source/evidence privileges and rejects RLS
   filtering. Inspect PUBLIC grants and use private encrypted PostgreSQL transport.
   Keep this credential separate from API, HLS inventory and other worker roles.
5. Use `pin-inventory.env.example` in your secret/configuration system outside Git.
   Match the deployment manifest. No S3, encryption, playback, moderation or signing
   keys are required. API `.env` is ignored.

## Run and inspect

Save a private JSON request using two UUIDs:

```json
{"id":"<new pin run UUID>","hlsRun":"<completed HLS inventory UUID>"}
```

```sh
node --env-file=/secure/pin-inventory.env dist/shorts/pin-inventory-main scan /secure/scan.json
```

Run one scan per node at a time. Each scan reads identity/capacity, streams recursive
pins then direct pins into PostgreSQL in batches of 50, and checks identity/capacity
again. Only successful EOFs and the final committed record set `pinTraversalComplete`
true. Counters are decimal strings. Capacity values are exact accepted integers
returned by Kubo (`repoBytes`, `storageMaxBytes`).

For `status`, use `{"id":"<pin run UUID>"}`. For `entries` and `missing`, add
`"limit":100` and paginate using returned `next` as `after`; null ends the pass:

```sh
node --env-file=/secure/pin-inventory.env dist/shorts/pin-inventory-main status /secure/run.json
node --env-file=/secure/pin-inventory.env dist/shorts/pin-inventory-main entries /secure/page.json
node --env-file=/secure/pin-inventory.env dist/shorts/pin-inventory-main missing /secure/page.json
```

- `entries`: pin types, original-reference count, HLS-package count, observed
  shared holds and `held` / `referenced` / `unresolved` classification.
- `missing`: expected CIDs without an observed **recursive** pin. A direct pin
  protects only that block, so a direct-only package is reported here too.
- `status`: node/storage identity, HLS reference run, timestamps, counts and
  repository-size observations before and after the traversal.

Keep outputs private; they include content identifiers across the node. Source
references are restricted to the selected deployment's historical HLS inventory.
A CID without such a match may belong to another deployment, an earlier version,
a recent job or an interrupted publication. **Unresolved does not mean disposable.**

## Interrupted scans and limits

[Kubo `pin/ls`](https://docs.ipfs.tech/reference/kubo/rpc/#api-v0-pin-ls) streams pins
but has no resumable cursor. This tool does not invent an offset or combine partial
traversals. An interrupted scan preserves committed batches as **incomplete**;
inspect `status`, investigate, and use a new UUID for a fresh scan. Reusing an ID
only returns saved status. It never resumes or replays the network scan. This also
makes a lost completion response recoverable. Evidence is not automatically pruned;
migration rollback refuses used tables.

Reads have a two-minute scan deadline, five-second response/idle deadlines, 16 KiB
small-metadata limit, 512-byte pin-line limit, and 100,000 observations / 16 MiB per
pin type. SQL work has the shared Shorts pool/statement deadlines. Cancellation and
shutdown close upstream requests. No automatic retries or skipped malformed records.
A larger node that exceeds these bounds stays incomplete; provision a measured
inventory strategy before increasing bounds. These are tooling limits, not a
supported production capacity claim.

Pins, source records and holds can change during/between scans. This is not a
consistent snapshot, proof of block integrity, proof that a CID is absent, or a
current playback authorization. CID matching uses exact returned encodings; equivalent
alternate encodings remain unresolved. Indirect blocks are not enumerated.

`RepoSize` is Kubo-reported repository usage, including data beyond these references.
`StorageMax` is its **soft GC threshold**, not a hard quota or filesystem capacity.
The report does not include host free bytes/inodes, scratch space, logs, edge caches,
backups or per-video physical byte attribution. Sample before/after values can differ
under normal writes and GC. Values above JavaScript's safe integer range fail closed.

Every result retains `deletionEnabled:false` and every pin `eligibleForDeletion:false`.
Actual cleanup requires agreed retention periods, current references/holds, coordinated
writers, recovery evidence and explicit unpin/GC behavior. Never delete from this report.

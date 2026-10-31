# Move existing Shorts to private shared storage

Use this when upgrading an API that has a local `shorts.sqlite`, `quarantine.key`
and encrypted files in `private/`. New installations do not need it. The command
runs the API's dedicated Nest migration module, with no HTTP listener, decoder,
contract signer or IPFS publishing access. It is currently testnet-only.

## Before starting

1. Stop the API that owns this data directory and take a consistent backup of the
   entire directory, its key, the public deployment manifest and PostgreSQL.
   Retain the original local files throughout the migration. Do not copy a live
   SQLite database without its committed WAL state.
2. Apply the API migrations, including `1791763214000-ShortsSharedCutover`.
3. Prepare a dedicated secret environment using `migration.env.example`. Set
   `SHORTS_DATA_DIR` to the existing absolute directory and use the exact deployment
   manifest matching its contract and source hash. The original `quarantine.key`
   is required; the command never generates a replacement. Private files and keys
   must be ordinary files; symlinked files or a redirected `private/` directory are
   rejected. The key must be owner-only.
4. Set the destination S3 configuration and encryption ring used by the hosted API.
   Use the trusted database migration identity, with access to the Shorts runtime,
   content, upload, ingestion, admission, playback-job, storage-import, measurement,
   receipt and legacy-cutover tables. Do not use the
   restricted media-worker login. Do not provide signing, streaming or IPFS keys.
   If the current contract has a predecessor, also mount its exact public deployment
   manifest as `SHORTS_PREVIOUS_DEPLOYMENT_FILE`. Both manifests must use the full
   versioned format in [README.md](README.md#contract-release-identity). The importer
   requires the predecessor address and compiler/source/bytecode/ACI hashes to match
   the current manifest's `previousContract` and `previousArtifact` before importing
   data. Missing or unrelated predecessor manifests are rejected. API startup
   independently verifies that binding against the chain.
   Keep `DOTENV_CONFIG_PATH=/dev/null` to avoid loading an API checkout's `.env`.

## Check, then copy

Build the API and run these commands from its checkout, replacing the environment
file path. The Node environment file remains outside Git with restricted permissions.

```sh
npm run build
node --env-file=/absolute/secrets/shorts-migration.env dist/shorts/legacy-storage-main.js --check
node --env-file=/absolute/secrets/shorts-migration.env dist/shorts/legacy-storage-main.js --apply
```

With the dedicated environment already injected by your deployment system, the
equivalent command is `npm run shorts:migrate:storage -- --check` or `-- --apply`.
The process takes the local SQLite ownership lock; it cannot run alongside the API
using that directory. Check mode verifies source metadata, encrypted originals,
file hashes and package CIDs without copying objects or importing shared records.

Apply copies original parts, manifests and prepared files as encrypted S3 objects
and reads each copy back before linking it. The original video ID, CID, creator,
publication status and current moderation decisions are preserved. Only private
storage references are attached to current content; an old approval never replaces
a newer decision. No content is newly approved, pinned, published or charged.

Saved partial uploads remain resumable with the same ID and accepted parts. An
interrupted preparation becomes queued with its previous attempt count; failed or
exhausted work stays failed. Already accepted jobs remain recoverable beyond the
original upload expiry. Unaccepted expired sessions are not revived. Recent upload
attempts retain their timestamps and byte costs, including failed attempts without
sessions. Older snapshots without budget records receive the original session
reservation, rather than a fresh upload-limit allowance.

Each item commits its shared records and checkpoint atomically, after storage IO.
The command reports counts only. On interruption, keep the source unchanged and
rerun `--apply`: completed entries are verified and skipped, and unfinished copies
resume. A changed source, corrupt ciphertext, wrong key or conflicting destination
stops the migration. An interrupted copy can leave unreferenced encrypted objects;
it cannot create a false completed checkpoint. No local or remote files are deleted.

Apply also imports analytics/privacy and transaction activity in their existing
fingerprinted transactions. It preserves measurement salt, lifetime counts, retained
plays and unexpired deletion markers. Receipt references retain their `legacy`
verification label. Both namespaces must be empty or match an earlier import;
starting a fresh API first can initialize them and block the import.

A deployment-scoped cutover record binds the full source snapshot and marks
completion only after storage, uploads, analytics and receipts succeed. The hosted
API refuses an incomplete cutover or a historical metadata import without this
completion record. Older partial migrations must rerun this command. No stored
review, publication or chain-confirmation evidence is fabricated by the migration.

## Finish the cutover

- Confirm apply exits successfully. Remove `SHORTS_DATA_DIR` and the old
  `SHORTS_IMPORT_LEGACY_*` flags from the hosted API environment. The dedicated
  migration configuration needs `SHORTS_DATA_DIR`, but not the old import flags.
  Start the API with shared PostgreSQL/S3 settings, then start its restricted workers.
- Verify private preview, saved-upload resume, approved playback, analytics,
  deletion markers and transaction history. Keep normal approval rules active.
- Retain the local backup and key until an independent restore and retention
  review permits removal. The API never reads this snapshot after cutover.
  Continue using one hosted instance until ingress limits and measured capacity
  support more; storage migration alone is not a scale certification.
- Do not restart an old release against the stale local snapshot after shared
  operation begins. New decisions and uploads belong to PostgreSQL/S3 and would
  diverge. Rollback requires reconciliation or restoration of a consistent backup.

The storage migration deliberately separates admission history from upload-session
lifetime. A schema downgrade refuses to reintroduce its former foreign key when
there are preserved attempts without sessions. Do not delete admission history or
checkpoints to force a downgrade; use a reviewed rollback/restore procedure.

`npm run test:shorts:legacy-storage` exercises the migration against isolated
loopback PostgreSQL and S3 test endpoints, with disposable SQLite snapshots. It
requires a current API build for the compiled-command checks. See
[private storage](PRIVATE-STORAGE.md) for provider requirements and test variables.

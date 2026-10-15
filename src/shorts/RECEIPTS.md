# Transaction activity history

The hosted API stores recent transaction references in PostgreSQL, scoped to the
configured network and contract. This history helps Studio resume and display
activity. Earnings, claimable balances and confirmations come from the existing
Shorts chain-indexing plugin; receipt history does not calculate or authorize them.

## Setup and migration

Run all normal API migrations, including `1791763208000-ShortsReceipts` and
`1791763214000-ShortsSharedCutover`, before starting Shorts. The trusted API database role needs SELECT, INSERT and UPDATE on
`shorts_receipt_scopes` and `shorts_transaction_receipts`, plus its existing
runtime/content permissions. Keep these tables inaccessible to the media-worker
login. Initialization verifies the deployment source hash and previous-contract
binding against the initialized runtime.

For a new installation, no import flag is needed. To preserve an existing local
receipt list:

Run the [offline legacy migration](LEGACY-STORAGE.md) before starting the hosted
API. Keep the exact deployment and previous-contract manifest, and an empty or
matching receipt namespace. The command migrates receipts together with the other
local state and records cutover completion. Hosted startup no longer accepts
`SHORTS_IMPORT_LEGACY_RECEIPTS` or accesses the local snapshot.

The import is atomic and fingerprinted. Repeating the migration with the same source does not replay
old values over newer receipts. Conflicting transaction identities, a changed
source list or a nonempty destination require reconciliation instead of a forced
overwrite. Duplicate historical references retain their earliest activity time.
Imported entries are labeled `legacy`; importing does not verify their chain status.

New hosted receipts are never written back to SQLite. Missing tables or database
failures fail the operation; there is no local fallback. The loopback demo retains
its local adapter. Do not restart an older release against the stale snapshot.
Schema rollback refuses to remove initialized history; reconcile or restore it
explicitly before downgrading.

## Receipt meaning

| Verification | Meaning |
|---|---|
| `legacy` | Reference copied from the previous local history; not revalidated |
| `submitted` | Operator publication returned a transaction hash; not a finality claim |
| `node_observed` | The node reported a successful mined call by the authenticated wallet to this or the verified previous contract |

For wallet acknowledgements, the API checks the transaction checksum, node network,
caller, target contract, successful call result, matching height and membership in
the node's generation. This is a point-in-time observation. It can change during a
reorganization and is not a replacement for the indexer's confirmation policy.
Receipt observations do not continuously track reorganizations; use the indexed
ledger for financial state.

The `(network, contract, transaction hash)` identity prevents duplicate receipts
across retries and API instances. An existing transaction cannot move to another
wallet or called contract. A delayed submission cannot downgrade a mined
observation. `at` is the first activity timestamp; `recordedAt` is the latest
persistence timestamp, not the transaction's mining or finality time. Studio gets
at most 15 references; the repository uses bounded, stable cursor pagination.

The receipt endpoint acknowledges an existing wallet transaction. It never signs
or broadcasts a replacement. After a receipt-write failure, retry that same hash;
do not ask the user to make the payment again. Operator publications use the
[isolated publisher](PUBLISHER.md) and its durable transaction journal. A missing
submission response resumes the same hash; it does not create a new signature.
Publication progress is separate from these wallet-activity references.

The complete API remains **single-instance** pending distributed ingress limits and
capacity restrictions. Shared receipts and isolated signing do not remove those
restrictions. Back up these tables with their scoped runtime records.

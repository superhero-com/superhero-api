# Publication transaction journal

`ShortsPublicationsModule` provides PostgreSQL persistence for an isolated
publisher. It has no key, node client, media decoder or local store dependency.
The hosted API and [publication worker](PUBLISHER.md) use the restricted
[database boundary](PUBLISHER-AUTHORITY.md). This unrestricted repository remains
reserved for trusted setup and migrations. The full API's remaining local state
still requires one instance.

## Runtime integration

The API admits the creator's publication request after preparing and verifying the
approved IPFS package. The isolated publisher claims that immutable request,
verifies the deployment and node, constructs the allowed call, signs it, saves the
exact signed transaction, and only then broadcasts those saved bytes. It checks
the existing hash after an uncertain response before deciding whether to resend
the same bytes. A replacement worker resumes the saved transaction.

The journal does not verify live chain observations itself. Its `settle` input
must come from a trusted publisher that independently checks the node network,
transaction hash/caller/contract, successful or reverted execution, canonical
block membership, confirmations and the resulting publication. It must also
reconcile already-published IDs before building a new transaction. No browser or
ordinary API request may supply a trusted settlement observation.

The [restricted database boundary](PUBLISHER-AUTHORITY.md) supplies separate API
and publisher roles through a scoped function. Finish the isolated runner,
deployment/artifact verification and API cutover before enabling this integration. Do not
grant the API or media-worker login write access to signer policies, raw signed
transactions or settlement state. This library by itself does not enforce SQL
privileges against a caller with broad database access. Runtime callers must use
the restricted boundary rather than this administrative repository directly.

## Journal guarantees

- Network, contract, operator and source hash must match the initialized runtime.
  This implementation permits testnet only. Account policy changes and operator
  rebinding require explicit reconciliation.
- Only the video's creator can enqueue it. Publication identity is immutable:
  ID, creator, CID and byte count cannot be replaced. Admission is bounded per
  operator and creator. Repeating an admitted request returns its existing state.
- At most one claimed or signed job exists per network/operator, even across
  replacement contracts. Database-time leases and increasing fences reject stale
  workers. A pause stops new admission and broadcasting, while outcome
  reconciliation remains possible.
- Signed payloads must have one valid operator signature for testnet and exactly
  the allowed nonpayable `publish(id, creator, cid, size)` call. Value is zero;
  nonce, bounded TTL, fee and worst-case gas cost are validated before persistence.
  Nested payment/authorization transactions and other contract methods are denied.
- Per-transaction and rolling 24-hour limits reserve the full fee plus maximum
  gas cost at persistence. Unresolved signed transactions remain reserved even
  after 24 hours. A revert does not refund its reservation; this is a conservative
  spending bound, not accounting of actual gas consumed.
- The exact bytes/hash are immutable after persistence. Expired worker leases
  never free an uncertain transaction's nonce or allow another job to bypass it.
  The journal's nonce high-water mark rejects a node view behind recorded work.
- Approval is rechecked before signing and authorizing broadcast. Lost approval
  blocks further sends but retains signed bytes for reconciliation. It cannot
  recall bytes already broadcast or prevent a send that was authorized immediately
  before revocation. Official viewing must continue checking current policy.
- Settlement keeps the signed payload and nonce, requires the configured depth
  of at least three blocks, and accepts an identical acknowledgement retry.
  It does not approve content or update published metadata. Chain indexing remains
  responsible for reorganization-aware earnings and confirmations.

Existing matching publications can enter `reconciled` with a verified historical
key-block anchor, without signing a transaction. This state reserves no nonce or
spending budget. The API still verifies current policy and publication identity.

Never log or return raw signed transactions to browser callers. They contain no
private key but can be broadcast by anyone who obtains them. Keep journal backups
restricted and consistent with deployment/content records. Rollback refuses to
drop an initialized journal. Restoring an old backup alone is unsafe: reconcile
all possibly broadcast transactions against the chain before resuming signing.
Unknown, expired or revoked signed transactions intentionally hold the account;
they need a verified recovery procedure, not a forced row deletion or nonce reset.

## Validation

`npm run test:shorts:publications` validates real offline signatures. With a
disposable loopback PostgreSQL database in `SHORTS_TEST_PG_URL`, it also exercises
competing connections, budgets, policy changes, failure rollback, lease expiry,
actual process-kill recovery and idempotent acknowledgements. It does not contact
a chain or certify custody, operator recovery, SQL role isolation or deployment.

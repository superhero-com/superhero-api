# Publication worker

The hosted API saves publication intent in PostgreSQL and acknowledges it without
waiting for IPFS. Its existing [lifecycle worker](LIFECYCLE.md) pins and verifies the
approved package under a renewable claim, then enqueues the signing request.
Before media work, it checks the operator and creator queue limits. A full or
paused queue defers preparation; this preflight does not reserve a signing slot.
An interrupted attempt can reuse an existing recursive pin after verifying its
files, while final queue admission still enforces the limits atomically.
A separate NestJS process
verifies and signs the contract call, saves its exact signed bytes, submits them,
and waits for chain confirmation. The API holds no operator signing key. Public
video delivery starts only after confirmation and the current content policy allow it.
The browser follows the same request after interruptions; a retry cannot create a
second signed transaction for that request.

This runtime currently accepts **testnet only**. Mainnet requires a separately
verified deployment and release configuration. The local, loopback demo retains
its existing inline signer. The full API still requires one instance while its
distributed ingress and capacity validation remain incomplete.

## Configure and start

1. Apply the API migrations with the migration owner. Create two dedicated database
   logins: the API login and `shorts_publisher`. Neither may own or have direct access
   to the publication journal, accounts, deployment bindings or principals. The
   publisher needs no access to any other application table. See
   [the database boundary](PUBLISHER-AUTHORITY.md) for required grants and checks.
2. Copy [publisher-policy.example.json](publisher-policy.example.json). Choose the
   spending and queue limits, then mount the **same policy file** in the API and
   publisher. Amounts are integer aettos (1 AE = 10^18 aettos); the example permits
   at most 0.002 AE per transaction and reserves up to 0.01 AE over 24 hours.
   Reservations include the maximum declared gas and unresolved older transactions.
   Prepare the [versioned release manifest](README.md#contract-release-identity)
   and mount the same reviewed identity in setup, the API and publisher. Legacy
   deployment receipts need the additional fields; they are not inferred from
   live chain responses or accepted with missing ABI/treasury commitments.
3. With the migration login, run the setup command once using an explicit env file.
   It needs `ENABLE_SHORTS=true`, `AE_NETWORK_ID=ae_uat`, `SHORTS_TESTNET_MVP=1`,
   `DB_*`, the absolute `SHORTS_DEPLOYMENT_FILE` and `SHORTS_PUBLISHING_POLICY_FILE`,
   plus `SHORTS_PUBLISHER_API_ROLE` and `SHORTS_PUBLISHER_DB_ROLE`. Do **not** provide
   `SHORTS_OPERATOR_KEY_FILE` to setup. The command initializes immutable bindings
   and enrolls the pre-created logins; it does not create passwords or transfer AE.
   Apply `1791763224000-ShortsUploadBudget` first. Setup grants the API read access
   to the shared [retained upload budget](UPLOAD-BUDGET.md). Set both
   `SHORTS_MAX_RETAINED_UPLOADS` and `SHORTS_MAX_RETAINED_SOURCE_BYTES` in this
   setup environment only when explicitly changing that budget; omitting them
   preserves the current limits. The command prints the effective budget and usage. Do not grant the runtime API permission to
   alter the counters or limits.

   ```sh
   npm run build
   node --env-file=/secure/publisher-setup.env dist/shorts/publisher-setup-main
   ```

4. On the hosted API, remove `SHORTS_OPERATOR_KEY_FILE` and its key mount. Set
   `SHORTS_PUBLISHING_POLICY_FILE`, preserve its public deployment/artifact files,
   and use the enrolled API database login. Excessive grants or a mismatched policy
   stop startup. No runtime service should use the migration-owner login.
5. Copy [publisher.env.example](publisher.env.example) into a private deployment
   environment. Use the separate publisher database login. Its operator key JSON
   (`{"secretKey":"..."}`) must belong to the process UID and be mode 0600 or 0400.
   The operator must be dedicated to this publisher: do not send unrelated wallet
   transactions from that account. Never share its key with media or API services.

   ```sh
   node --env-file=/secure/publisher.env dist/shorts/publisher-main
   ```

   Alternatively, use `compose.shorts-publisher.yaml` with an immutable API image
   digest and its required file paths. Start the publisher before opening uploads.
   Its only network dependencies are PostgreSQL and the manifest's `node` origin.
   The optional `SHORTS_PUBLISHER_NODE_URL` override must equal that origin.
   Configure network policy accordingly; Compose resource limits do not enforce egress.

The Compose template bounds Docker stdout/stderr logs to three 10 MB files per
container. Apply changes by recreating the container; restarting alone keeps its
old logging configuration. Export required operational logs to your controlled
logging system before they rotate. This log cap does not bound PostgreSQL/WAL,
backups or other host storage, and is separate from media retention. Reserve and
monitor aggregate space across replicas and stopped containers; never delete
publication journal rows or backup generations to relieve pressure automatically.

## Behavior and recovery

- One unresolved transaction per operator, across contract bindings. Concurrent
  processes use database leases and fences; a replacement recovers the saved bytes.
- A node timeout or lost submission response triggers observation of the same hash.
  Only the saved bytes may be resent. Pending or expired transactions never receive
  a replacement nonce automatically.
- Each attempt has a 120-second work deadline spanning all node calls, in addition
  to the 8-second deadline for each individual HTTP request and response body.
  Lease expiry, a failed renewal or process shutdown cancels in-flight node HTTP.
  Renewals use a conservative local lease deadline measured from before the database
  request; a late acknowledgement cannot revive an expired attempt. A stopped attempt
  cannot start signing or advance to another publication phase.
- Cancellation does not undo a submitted transaction or a database write already
  in progress. The process drains outstanding [bounded SQL](DATABASE.md) before
  starting another attempt. On shutdown it leaves the durable lease to expire,
  without starting a release query; a replacement then observes the saved hash.
  Keep the Compose 90-second shutdown grace period. The 120-second work deadline
  is not a hard process-exit deadline: SQL drain and fenced release can add time.
- Existing matching publications are adopted after a stable historical chain read,
  without another signature. Confirmed jobs retain their block anchor; the API
  checks it again before marking content published.
- Current approval is checked at admission, signature persistence and send
  authorization. Revocation prevents future sends; a transaction already sent
  cannot be recalled. Delivery still checks the current policy independently.
- Unknown, expired, revoked or conflicting signed outcomes hold the operator queue.
  Investigate the canonical transaction and account state. **Do not delete journal
  rows or reset nonce reservations to clear the queue.** Reconcile before resuming.
- Publisher replicas provide recovery, not parallel throughput for a shared operator.
  The single unresolved transaction rule serializes publications until confirmation.
  Measure queue age and chain confirmation time before opening admission further;
  adding replicas or shortening polling cannot remove that limit.
- Pause through the protected account policy using the administrative process.
  Runtime logins cannot modify policy or enrollment. Policy changes require a
  coordinated update of the mounted file and protected database binding.
- Back up the journal with its deployment bindings and role enrollment. Restore and
  reconcile before restarting signing; restoring an older database without checking
  chain nonce/history can lose evidence of already submitted transactions.

The database trusts the restricted publisher's observations. Its runtime checks
node network, contract bytecode, caller, calldata, canonical block membership and
confirmation depth; a malicious configured node, compromised signing process or
deep reorganization remains an operational trust boundary. Confirmation depth is
not absolute finality. Never use these request states as a replacement for the
shared MDW accounting/indexing plugin.

`GET /api/shorts/:id/publication` is creator-authenticated and returns progress.
`POST /api/shorts/:id/publish` returns 202 while pending, or 200 after publication.
`preparing` means intent is saved but media verification has not yet admitted a
signing request; `queued`, `claimed` and `signed` reflect the publication journal.
Storage capacity pauses retain that intent and retry through the lifecycle queue.
They do not cause a new wallet signature or reset the signer queue's limits.
Neither endpoint returns raw signed bytes or submits a browser wallet transaction.
Tests: `npm run test:shorts:publisher` plus `test:shorts:publisher-authority` with a
disposable local `SHORTS_TEST_PG_URL`; they use unfunded fixture keys and simulated
node observations. Live-node staging verification is a separate deployment check.

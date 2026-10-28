# Zero-payment Likes and network-fee sponsorship

The current schema-2 contract accepts only nonpayable `like(id, expected_config_version)` calls. A Like transfers zero AE and creates no reward liability. A dedicated Superhero account pays the network fee using `PayingForTx`; the viewer still approves the exact inner transaction in their wallet. The fee key has no publishing, ownership or treasury authority. This service accepts `ae_uat` only.

## Configuration and isolated processes

Sponsorship defaults to disabled. It requires the reviewed zero-fee deployment manifest and matching artifact, an authenticated Shorts session, a wallet that supports inner-transaction signing, and a separately funded basic fee-payer account. The API and signer must use identical public release and policy files. Keep their database credentials distinct.

Both processes require:

- `AE_NETWORK_ID=ae_uat`, `SHORTS_TESTNET_MVP=1`; both demo authentication/approval flags disabled.
- `SHORTS_DEPLOYMENT_FILE` and `SHORTS_CONTRACT_ARTIFACT` bound to the new deployment and compiled artifact.
- `SHORTS_LIKE_SPONSOR_POLICY_FILE`: absolute regular JSON file as below.
- `SHORTS_LIKE_SPONSOR_DATABASE_URL`: a dedicated restricted queue login. The API uses an enrolled `api` login; the signer uses an independently enrolled `signer` login.
- `SHORTS_LIKE_SPONSOR_ENABLED=true` permits new admission/signing only after database enrollment and unpausing.

Only the signer receives `SHORTS_LIKE_SPONSOR_KEY_FILE`: an absolute, owner-only regular JSON file containing its `secretKey`. Never mount this key in the HTTP API, web image or publisher. The signer refuses publisher and private-media credentials. Run the built isolated Nest module with `npm run start:shorts:like-sponsor`; it loads no HTTP server or media services. Supply its environment explicitly; it does not load a shared `.env` file.

Example policy (amounts are integer decimal strings in aetto):

```json
{
  "payer": "<dedicated ak_ fee-payer address>",
  "gasLimit": 100000,
  "gasPrice": "1000000000",
  "maxFee": "1000000000000000",
  "maxTransactionCost": "3000000000000000",
  "rollingCostLimit": "30000000000000000",
  "maxPending": 10,
  "maxActorPerDay": 20,
  "maxRequestsPerDay": 100,
  "ttlBlocks": 20
}
```

`maxFee` caps each inner and outer fee; `maxTransactionCost` caps their sum plus the inner gas limit multiplied by gas price. Hard bounds additionally limit gas to 200,000, gas price to 100 billion aetto, each fee to 10^16 aetto, total cost to 10^17 aetto, and TTL to 50 key blocks. The whole payer shares its pending, request and 24-hour spending limits across enrolled contracts. Costs remain conservatively reserved for unresolved transactions and for the rolling window after rejected, failed or expired attempts; they are not refunds or estimates of actual gas used. Set platform-wide limits before providing public access: per-wallet limits alone do not prevent Sybil abuse.

## Explicit database enrollment

Apply the normal API migrations using the migration administrator. The sponsorship migration creates the queue and `shorts_like_sponsorship(text,jsonb)` boundary, but creates no login, enrolls no principal and enables no payer.

Using a separate database administrator, provision two nonprivileged login roles, with independent passwords delivered through secret configuration. Each role must have only the database connection, schema usage and execute permission on this one function. Do not grant role memberships, table/column permissions, schema/database creation, ownership, bypass-RLS, superuser, replication, or access to any other application security-definer function. Public grants that imply these privileges also cause startup to fail. Do not reuse the ordinary API, media worker or publisher logins.

Enrollment consists of these administrator-owned records:

1. `shorts_like_sponsor_accounts`: the `ae_uat` network, dedicated payer, exact normalized policy object **without** its `payer` property, and `paused=true` initially.
2. `shorts_like_sponsor_deployments`: verified network, contract, source hash and payer. The corresponding `shorts_runtime` release binding must already exist and match.
3. `shorts_like_sponsor_principals`: each login's actual `pg_roles.oid` and role name, the matching deployment, its `api` or `signer` kind, and enabled flag. A renamed/recreated login cannot inherit enrollment implicitly.

Verify each process starts with its intended restricted role, reviewed configuration and dedicated account before the administrator explicitly clears the payer's paused flag. No HTTP endpoint changes enrollment, policy, roles or budgets. Back up these tables together with runtime state; do not delete journals or reset nonce/budget history to unblock a request.

## Admission and recovery

`POST /shorts/like-sponsorships` requires a bearer session and `{id, videoId, signedInnerTx}`. The signed caller must be that session's actor. The API accepts only a canonical single-signature basic-account inner transaction in the `ae_uat-inner_tx` domain, for the pinned contract's exact Like method, zero amount, bounded gas/fee and finite TTL. The UUID, signed bytes and inner hash are immutable. Retry the identical request after an uncertain acknowledgement; do not create a new transaction or nonce.

The signer independently verifies release bytecode, authority, live configuration, migration state and signatures. It reads account nonce and simulates the exact call at one current block hash before signing. Deterministic failure and nonce gaps reject that request without signing. Transient read failures remain unresolved. A fenced database lease reserves the canonical unsigned outer envelope, payer nonce and maximum cost before signing. Restart reuses that exact envelope. The signed outer must be durably stored before any broadcast; retries only rebroadcast those same bytes.

`GET /shorts/like-sponsorships/:innerHash?address=...&contract=...` is a bounded public observation endpoint. Its `tx` stays the user-signed inner hash; `sponsoredTx`, when present, identifies the fee-payer envelope. Responses never include signed bytes. Canonical execution checks bind both layers and require three confirmations before success or execution failure. A missing transaction or node outage remains unknown.

An immutable rejected request with no persisted outer returns `neverSubmitted=true`. This proves the service has not submitted that envelope, not that no signature was ever constructed in worker memory. A persisted outer may be declared expired only after a stable canonical anchor at least three key blocks beyond its TTL, explicit absence/noncanonical inclusion, and proof the payer nonce was unconsumed. The retained `expiryProof` contains `ttl`, `height`, `blockHash` and `payerNonce`. Later reads recheck the historical anchor, so legitimate subsequent payer transactions do not invalidate expiry. If the payer nonce advanced without known canonical settlement, recovery stays blocked for operator reconciliation. These are bounded testnet confirmation assumptions, not protection from arbitrarily deep reorganizations.

To pause admission, set `SHORTS_LIKE_SPONSOR_ENABLED=false` and restart the applicable processes, retaining policy/release/database configuration so existing requests remain observable. A database payer pause blocks new reservations and broadcasts immediately; observation and settlement remain available. Disabling an enrolled principal revokes that login's entire boundary. Never remove its key, binding or journal until outstanding signed transactions have been reconciled.

The conservative queue permits only one active reserved/signed transaction per payer until canonical settlement reaches three confirmations (or proven expiry). This limits a single payer to roughly one Like per confirmation window, regardless of how many HTTP requests are admitted. It is a correctness-first testnet integration, not a production throughput configuration. Increasing concurrent payer nonces requires a separate ordered-journal and recovery design.

## Local verification

Run `npm run test:shorts:like-sponsorship` for signature, transaction, observation and worker checks. Run `npm run test:shorts:like-sponsorship-database` with `SHORTS_TEST_PG_URL` pointing to a dedicated disposable PostgreSQL database on loopback for real SQL authority and concurrency checks. The database suite requires an administrator that may create random test roles and a random schema; it cleans up only those test-owned objects. Never point it at a shared or production database.

The database suite exercises the actual migration, enrollment and privilege checks, concurrent admission, shared-payer budgets, leases and fencing, immutable nonce reservations, persistence before submission, pause behavior and expiry recovery. Its worker recovery case uses real PostgreSQL commits with a simulated node transport; passing it does not replace a live wallet/node test or establish production throughput.

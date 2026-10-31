# Wallet transaction observations

`GET /api/shorts/wallet-transactions/:tx?address=ak_...&contract=ct_...`
returns a fresh observation for a paid Like, reward claim or withdrawal. It reads
public chain data, needs no wallet ownership signature, returns `Cache-Control:
no-store`, and never signs, submits, writes a receipt or changes content. It is
available only when Shorts is enabled. The current runtime supports testnet only.

The caller supplies the saved transaction hash, wallet and exact contract. The
contract must be the configured current deployment, or its configured previous
deployment for a claim. Changing any supplied identifier does not give the caller
a new rate-limit allowance. The shared budget allows 30 checks per minute per
client address and 120 across the deployment; overload returns 429 with
`Retry-After`. Existing bounded node transport, operation deadlines and shutdown
cancellation apply.

| Status | Meaning |
| --- | --- |
| `unknown` | The configured node returned 404. This does not prove rejection, expiry or absence from other nodes. |
| `submitted` | The exact signed transaction is in the node's mempool. Execution has not been observed. |
| `mined` | Its execution is in the current generation, but fewer than three confirmations have accumulated. `result` may already be `ok`, `revert` or `error`. |
| `confirmed` | Matching successful execution has at least three confirmations on the observed canonical chain. |
| `failed` | Matching `revert` or `error` execution has at least three confirmations. Network fees can still have been charged. |
| `reorged` | The node still reports a mined transaction, but its microblock is absent from the current generation. Its eventual outcome remains unresolved. |

Successful observations include wallet, network, contract, transaction hash and
`confirmationsRequired`. Once the transaction is found, they also include method,
video ID where applicable, exact amount in aettos and nonce. Mined observations
include block hash/height and confirmation count. Raw transaction bytes and
signatures are not returned. The observer reconstructs and verifies the signed
transaction hash and signature, checks method/caller/contract and execution
identity, and rejects inconsistent or changing confirmation snapshots. The
single-signature verifier accepts the SDK's network-prefixed transaction hash
and legacy network-prefixed transaction bytes. Both remain bound to `ae_uat`;
signatures for another network, inner transactions or missing network prefixes
are rejected. The actual signed nonce is returned for comparison with the
client's saved action.
The confirmation convention matches the accounting index: tip height minus transaction
height plus one. Generalized-account or nested transactions are not supported by
this endpoint.

Clients must persist their action context and transaction hash before broadcast,
then reconcile the same hash after interruption. Never automatically submit a
replacement because this endpoint returns `unknown`, `submitted`, `mined`,
`reorged`, a timeout or an error. Recheck after reload and when returning to an
account; a formerly confirmed block can later be reorganized. Do not interpret
an HTTP failure as proof that no payment occurred. Compare observations with the
saved action, amount and contract before updating its UI.

This endpoint trusts the configured node's chain/execution observations. Signature
verification does not prove node honesty, and confirmation depth is not absolute
finality. It does not replace the shared MDW accounting plugin, authorize a second
transaction or grant access to private Studio data. The existing authenticated
`POST /receipt` remains an optional activity reference, not confirmation authority.

Run `npm run test:shorts:wallet-transactions` for offline signature, identity,
execution and reorganization cases. `test:shorts:rates` additionally exercises
real HTTP admission against disposable local Redis.

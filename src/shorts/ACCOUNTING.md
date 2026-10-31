# Shorts reward reconciliation

The hosted API provides an operator-only, read-only comparison of indexed paid
Likes and claims with the configured Shorts contract. It includes creator and
treasury rewards. It does not sign transactions, repair data or move funds.

## Run a comparison

Call `GET /api/shorts/operator/reconciliation` with an existing operator session
in the `Authorization: Bearer ...` header. The endpoint uses the shared private
operator rate limit and returns `Cache-Control: no-store`. Keep credentials out
of URLs and logs. No new key, environment variable, migration or service is needed.
The local SQLite demo does not provide this comparison.

| Query | Use |
|---|---|
| `contract` | Optional configured contract address; defaults to the current contract. Arbitrary addresses are rejected. |
| `height` | Optional confirmed key-block height. Omit on the first request to select a recent closed generation. |
| `blockHash` | Check the expected key-block hash at `height`. Required when continuing account pages. |
| `after` | Previous response's `accounts.next`; pass the original `height`, `blockHash` and `contract` too. |

The service currently requires `ae_uat` and the platform-funded Shorts accounting
interface: `get_config`, `get_liabilities` and `get_account`. An older deployment
without this interface needs its own accounting adapter. This endpoint does not
enable mainnet or reconcile legacy hosting payments.

All contract observations use the exact same key-block hash as the dry-run `top`.
The database comparison includes generations strictly below that block's height;
microblocks in its own generation are excluded. The selected boundary gives the
newest included transactions at least the index's three-confirmation requirement.
The canonical hash, depth and network are checked again before returning. A reorg
can still occur after a response; record the block identity with the result and
re-run following a reorg. See the [æternity consensus description](https://docs.aeternity.com/developer-documentation/protocol/consensus)
for the key-block/microblock distinction.

Index coverage must be current, with no known failed projection. A read-only
repeatable-read SQL transaction checks projection versions, event counts and
source heights/timestamps before computing the totals. Node and database reads
retain their existing workload deadlines. One comparison runs per API process;
overlapping calls receive 503. Large histories may exceed the database deadline;
that is a failed check, not a successful reconciliation. Each account page repeats
the aggregate queries, so schedule diagnostics within measured database capacity.

## Read the result

Amounts are **decimal strings in aetto**, never floating-point AE. For every Like,
the treasury receives `floor(fee × treasuryBasisPoints / 10000)` and the creator
receives the remainder. When the creator is also the treasury, both credits belong
to that single account. Claims reduce available rewards and total liability; they
do not reduce lifetime earnings.

- `summary.liabilitiesMatch`: indexed creator credits plus treasury credits minus
  claims equal the contract liability, with no invalid indexed accounting events.
- `summary.solvent`: the observed contract balance covers its reward liability.
  `unallocatedBalance` separates surplus funds from liabilities. Surplus is not
  creator income; a negative amount indicates a deficit.
- `accounts.items`: up to five accounts, each comparing lifetime `earned`,
  `claimed` and `available`. A total can match while an individual account differs.
- `accounts.next`: continue while non-null, always using the same contract and
  returned block identity. No response claims that all account pages were checked.

A complete scheduled check must examine the summary and every account page for
each supported deployment. Keep a private result with the contract, block hash,
page coverage and differences. Non-2xx responses, mismatches, stale indexing,
missing pages and timeouts all require investigation. Retry 409 from a fresh
first page; investigate sustained 503 before retrying under backoff. Do not repair
balances or submit claims automatically in response to a mismatch.

This compares the indexed history with the trusted node's observed state. It does
not independently prove complete chain ingestion, discover accounts absent from
that history, or replace a contract audit. Configure a daily run, a named incident
owner and alert delivery in the deployment's monitoring system; the API does not
install a scheduler or declare operational coverage itself.

## Local verification

`npm run test:shorts:reconciliation` includes HTTP authorization checks and a SQL
suite enabled by `SHORTS_TEST_PG_URL` pointing at a disposable loopback PostgreSQL
database. The SQL suite creates and removes its own random schema.

`npm run test:shorts:reconciliation:devnet` verifies the SDK's historical-read
boundary with real Like and claim transactions. Supply `SHORTS_TEST_DEVNET_URL`
and `SHORTS_TEST_COMPILER_URL` for a disposable loopback node/compiler,
`SHORTS_TEST_DEVNET_WALLETS` for a JSON array of newly generated, genesis-funded
fixture accounts (`secretKey` fields), and `SHORTS_TEST_CONTRACT_SOURCE` for the
matching `Shorts.aes` file. The test rejects any network other than `ae_dev`.
Remove the fixture wallets and owned chain afterward; never supply real wallets.

# Address Links -- Architecture

The address-links module lets users link external identities (Nostr npub, X handle, etc.) to their Aeternity wallet address. Links are stored on-chain via a smart contract and cached locally in the `accounts.links` JSONB column.

## System overview

```
Frontend / Mobile App                 NestJS Backend                   Aeternity Chain
        |                                  |                                |
        |  POST /address-links/:provider/  |                                |
        |       claim                      |                                |
        |  ==============================> |                                |
        |                                  |  contract.get_nonce(address)   |
        |                                  |  ============================> |
        |                                  |  <==== nonce ================= |
        |                                  |                                |
        |                                  |  Provider-specific             |
        |                                  |  verification (claim phase)    |
        |                                  |                                |
        |  <== { message, nonce, value } = |                                |
        |                                  |                                |
        |  (user signs message with AE     |                                |
        |   wallet + provider proof)       |                                |
        |                                  |                                |
        |  POST /address-links/:provider/  |                                |
        |       submit                     |                                |
        |  ==============================> |                                |
        |                                  |  Provider-specific             |
        |                                  |  verification (submit phase)   |
        |                                  |                                |
        |                                  |  contract.link(addr, ..., sig) |
        |                                  |  ============================> |
        |                                  |  <==== Link event ============ |
        |  <======== { txHash } ========== |                                |
        |                                  |                                |
        |                                  |  Plugin picks up Link event    |
        |                                  |  Updates accounts.links JSONB  |
```

## Linking flow

Every provider follows the same two-step pattern:

1. **Claim** -- The frontend sends the user's address (and provider-specific data). The backend verifies the claim, fetches the current nonce from the contract, builds the message string, and returns it.

2. **Submit** -- The frontend signs the message with the AE wallet and attaches provider-specific proof (e.g. a signed Nostr event, an HMAC verification token from claim). The backend verifies the proof, then broadcasts a `link()` transaction to the smart contract.

The message format is deterministic:

```
link:<address>:<provider>:<value>:<nonce>
unlink:<address>:<provider>:<nonce>
```

## Module structure

```
src/plugins/address-links/
|-- address-links.module.ts           # API module (controllers, service, verifiers)
|-- address-links.service.ts          # Shared orchestration (claim, submit, unlink)
|-- contract.service.ts               # AE SDK wrapper, message building, tx broadcasting
|-- address-links.constants.ts        # Environment variable bindings
|
|-- nostr-link.controller.ts          # POST /address-links/nostr/*
|-- x-link.controller.ts              # POST /address-links/x/*
|
|-- dto/
|   |-- nostr/                        # Nostr-specific request DTOs
|   |   |-- claim-nostr-link.dto.ts
|   |   |-- submit-nostr-link.dto.ts
|   |   |-- unclaim-nostr-link.dto.ts
|   |   +-- submit-nostr-unlink.dto.ts
|   +-- x/                            # X-specific request DTOs
|       |-- claim-x-link.dto.ts
|       |-- submit-x-link.dto.ts
|       |-- unclaim-x-link.dto.ts
|       +-- submit-x-unlink.dto.ts
|
|-- verification/
|   |-- link-verifier.interface.ts    # VerifiedClaim type
|   |-- nostr-link-verifier.service.ts
|   +-- x-link-verifier.service.ts
|
|-- aci/
|   +-- AddressLink.aci.json          # Contract ABI
|
|-- address-links.plugin.ts           # Plugin for live indexer (tx filtering)
|-- address-links-plugin-sync.service.ts  # Plugin sync (event decoding, DB updates)
+-- address-links-plugin.module.ts    # Plugin module (separate from API module)
```

## Two NestJS modules

The address-links feature is split across two modules:

**`AddressLinksModule`** -- The API layer. Registers the controllers, service, contract service, and verifiers. Imported by `AppModule`.

**`AddressLinksPluginModule`** -- The event indexing layer. Implements the `Plugin` interface used by the `mdw-sync` live indexer. Registered in `src/plugins/index.ts` alongside other plugins (BCL, Social, Dex, etc.).

## Event indexing (plugin)

When a `link()` or `unlink()` transaction is confirmed on-chain, the live indexer routes it to `AddressLinksPluginSyncService`, which:

1. Fetches contract logs from the Aeternity middleware for that transaction.
2. Matches events by `event_hash` (base32hex-encoded Blake2b of the event name).
3. Converts the integer address from the log args to an `ak_...` address.
4. Reads the payload from `log.data` (format: `provider:value`).
5. Creates the account row if it doesn't exist (`ensureAccount`).
6. Updates the `links` JSONB column via `jsonb_set` (link) or `links - 'key'` (unlink).

## Database

The `accounts` table has a `links` JSONB column:

```json
{
  "nostr": "npub1xyzabc...",
  "x": "superherocom"
}
```

Queried via `GET /accounts/:address` -- the `links` field is included in the response.

```sql
-- Find all accounts linked to a provider
SELECT * FROM accounts WHERE links ? 'nostr';

-- Find who owns a specific identity
SELECT * FROM accounts WHERE links->>'nostr' = 'npub1xyzabc...';
```

## Environment variables

| Variable | Description |
|---|---|
| `ADDRESS_LINK_SECRET_KEY` | Provider wallet secret key (`sk_...`). The backend uses this to broadcast transactions. |
| `ADDRESS_LINK_CONTRACT_ADDRESS` | Deployed contract address (`ct_...`). |
| `ADDRESS_LINK_VERIFICATION_TTL_SECONDS` | TTL for X verification tokens (default: 300). |
| `ADDRESS_LINK_NOSTR_EVENT_MAX_AGE_SECONDS` | Max age of Nostr proof events (default: 300). |

## API endpoints

Each provider has its own set of 4 endpoints under `/address-links/<provider>/`:

| Endpoint | Purpose |
|---|---|
| `POST /address-links/<provider>/claim` | Get the message to sign |
| `POST /address-links/<provider>/submit` | Submit signatures, broadcast to chain |
| `POST /address-links/<provider>/unclaim` | Get the unlink message to sign |
| `POST /address-links/<provider>/unclaim/submit` | Submit unlink signature, broadcast |

See [frontend-guide.md](frontend-guide.md) for full API reference per provider.

## AE wallet signature format

The on-chain contract verifies signatures against a 60-byte digest:

```
AE_MESSAGE_PREFIX (28 bytes) + blake2b_256(message_utf8) (32 bytes)
```

The prefix is:

```
0x1a "aeternity Signed Message:\n "
```

Frontends must use `unsafeSign(digest)` -- **not** `signMessage()` which produces a different 32-byte hash.

## Contract events

| Event | Log format |
|---|---|
| `Link` | `args[0]` = address (integer), `data` = `"provider:value"` |
| `Unlink` | `args[0]` = address (integer), `data` = `"provider:value"` |

Events are matched by `event_hash` (base32hex encoding), not by name.

## Input constraints

| Field | Type | Max length | Allowed characters |
|---|---|---|---|
| `address` | string | -- | Must be valid `ak_...` |
| `provider` | string | 10 | Lowercase `a-z` only (enforced by contract) |
| `value` | string | 200 | Any except `:` |
| `nonce` | number | -- | Sequential integer per address |
| `signature` | string | 128 chars | Hex-encoded 64-byte Ed25519 signature |

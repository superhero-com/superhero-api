# Profile Identity Integration

This document describes how frontend/backend interact with the on-chain
`ProfileRegistry_v1` contract.

## Contract entrypoints used by frontend

- `set_profile(fullname, bio, avatarurl)`
- `set_profile_full(fullname, bio, avatarurl, username_opt, chain_name_opt, chain_expires_at_opt, source)`
- `set_custom_name(username)`
- `clear_custom_name()`
- `set_chain_name(chain_name, expires_at)`
- `clear_chain_name()`
- `set_x_name_with_attestation(x_username, expiry, nonce, signature)`
- `clear_x_name()`
- `set_display_source(source)`

All write calls must be sent from the user wallet (`Call.caller` owner model).

### Contract validation notes

- `set_chain_name` and `set_profile_full(..., chain_name_opt, ...)` now validate chain ownership on-chain via AENS lookup (name must currently belong to `Call.caller`).
- Contract still enforces:
  - `expires_at > Chain.timestamp`
- For chain/custom collisions:
  - chain names are stored as full values (for example `alice.chain`),
  - custom-name conflict comparison uses chain base semantics (`alice.chain` conflicts with custom `alice`),
  - when chain verification wins, conflicting custom names are auto-renamed using existing conflict rules.
- Custom names remain globally unique.
- X usernames ending with `.chain` are rejected (`CHAIN_SUFFIX_RESERVED`) because `.chain` is reserved for AENS names.
- `x_username` remains attestation-gated (`set_x_name_with_attestation`) and is not directly settable via bulk setup.

## Backend endpoints

- `POST /api/profile/x/attestation`
  - Input (either one):
    - Token flow:
      - `address` (`ak_...`)
      - `accessToken` (X OAuth access token)
    - Code flow (OAuth2 PKCE):
      - `address` (`ak_...`)
      - `code` (authorization code from X callback)
      - `code_verifier` (PKCE verifier used with authorize)
      - `redirect_uri` (must be exactly the same URI used in authorize request)
  - Output:
    - `x_username`
    - `expiry`
    - `nonce`
    - `signature_hex`
    - `signature_base64`
    - `signer`

- `GET /api/profile/:address`
  - Returns merged profile data from backend cache by default.
  - Optional query: `includeOnChain=true` to augment with direct contract read.

- `GET /api/profile/:address/onchain`
  - Explicit contract dry-run read (no payment).
  - Use this for debugging or fallback, not for feed-scale polling.

- `GET /api/profile?addresses=ak_1,ak_2,...`
  - Batch read for visible user cards in social feed.
  - Optional query: `includeOnChain=true` for hybrid mode.

- `GET /api/profile/feed?limit=20&offset=0`
  - Paginated feed from `profile_cache`.
  - This is the preferred scalable path for high-traffic reads.

## Attestation payload format

The backend signs this exact message:

`profile_x_attestation:{address}:{x_username}:{expiry}:{nonce}`

The contract verifies this message with the configured backend signer.

## Frontend flow

1. User starts X OAuth2 authorize flow with PKCE.
2. Authorize URL requests at least: `users.read` and `tweet.read`.
3. X redirects to frontend callback with `code`.
4. Frontend calls `POST /api/profile/x/attestation` with either:
   - token flow: `{ address, accessToken }`, or
   - code flow: `{ address, code, code_verifier, redirect_uri }`.
5. If using code flow, backend exchanges code for access token with X and verifies `/2/users/me`.
6. Frontend converts `signature_hex` into bytes and sends wallet tx:
   - `set_x_name_with_attestation(x_username, expiry, nonce, signature_bytes)`.
7. Frontend refreshes profile via `GET /api/profile/:address`.

Notes:
- `redirect_uri` must match exactly in three places: frontend authorize request, backend attestation payload, and X App callback settings.
- If X returns `403 Forbidden` from `/2/users/me`, verify app/project API v2 access and required scopes.

## Scalability strategy

- **Writes:** always wallet tx to contract.
- **Reads (default):** backend cache endpoints (`/feed`, batch `/profile?addresses=...`).
- **Reads (fallback):** `/profile/:address/onchain` or contract direct dry-run only when needed.
- This avoids excessive mainnet dry-runs and keeps social feed performance stable.
- **Cache freshness:** backend now combines live middleware websocket subscriptions (contract-call driven refresh) with cron polling fallback, so profile changes (including `set_profile` and `set_profile_full`) are reflected faster and still resilient to websocket gaps.

## Env variables

Add these values in backend env:

- `PROFILE_REGISTRY_CONTRACT_ADDRESS`
- `PROFILE_ATTESTATION_SIGNER_ADDRESS`
- `PROFILE_ATTESTATION_PRIVATE_KEY`
- `PROFILE_ATTESTATION_TTL_SECONDS` (default `300`)
- `X_CLIENT_ID`
- `X_CLIENT_SECRET` (optional for public PKCE clients; recommended for confidential clients)

## Deploy preparation (no live deploy executed)

Contract source and deployment tooling are maintained outside this repo. The backend uses the ProfileRegistry ACI bundled at `src/profile/contract/ProfileRegistryACI.json` for reading profiles and decoding events.

### 1) Backend post-deploy config

Set env vars:

- `PROFILE_REGISTRY_CONTRACT_ADDRESS=ct_...`
- `PROFILE_ATTESTATION_SIGNER_ADDRESS=ak_...`
- `PROFILE_ATTESTATION_PRIVATE_KEY=...`

Then restart backend and validate:

```bash
npm run build
npm run start:dev
```

### 2) Clearing profile cache after new contract deploy

When you deploy a new ProfileRegistry contract, clear the old cached profile data so the app uses the new contract and does not serve stale rows.

**If the DB runs in Docker** (e.g. `docker-compose` postgres):

From repo root, either run the script (finds the postgres container automatically):

```bash
bash scripts/profile-cache-clean.sh
```

Or run the SQL manually (replace `CONTAINER` with your postgres container name, e.g. `superhero-api-postgres-1`):

```bash
docker exec -i CONTAINER psql -U postgres -d bcl_api -f - < scripts/profile-cache-clean.sql
```

Or one line (use single quotes so the shell does not split the SQL):

```bash
docker exec -i CONTAINER psql -U postgres -d bcl_api -c 'TRUNCATE profile_cache; TRUNCATE profile_sync_state;'
```

To find the postgres container name: `docker ps` or `docker compose ps` (look for the postgres service).

**If the DB is local or remote**, run the same SQL with your client (e.g. `psql -U postgres -d bcl_api -f scripts/profile-cache-clean.sql`).

After clearing, the indexer and live sync will repopulate from the new contract; single-profile reads will fall back to on-chain until cache is filled.

### 3) Smoke test checklist

1. `POST /api/profile/x/attestation` returns signature payload.
2. Wallet calls `set_x_name_with_attestation(...)` successfully.
3. `GET /api/profile/:address` shows updated names/public_name.
4. `GET /api/profile/feed` and batch endpoint return cached data without per-user on-chain reads.

# Shorts testnet MVP

An opt-in NestJS feature module connected to a real æternity testnet contract. It can run inside the normal API on staging, or separately for local development without the main databases and relays. The web feature runs within Superhero's existing application and wallet providers.

## Enable on staging

Shorts is disabled by default. Set **`ENABLE_SHORTS=true`** on the API to load its
routes, storage and background tasks. All other values leave them unloaded.
Restart after changing the flag. The standalone development entrypoint requires
the same flag. Turning it off preserves saved data.

The normal API entrypoint supports a **single testnet staging instance** with
Node 22.13+, FFmpeg/FFprobe, `AE_NETWORK_ID=ae_uat`, `SHORTS_TESTNET_MVP=1`,
`NODE_ENV=production`, `SHORTS_WEB_ORIGIN` set to the exact HTTPS website origin,
and an absolute persistent `SHORTS_DATA_DIR`. Mount the contract artifact,
deployment receipt, and a dedicated **testnet operator** key using the paths in
`shorts.env.example`. Both local demo flags must be `0`; hosted startup rejects them.
The current SQLite snapshot store must not be used by multiple API replicas.
It is a bounded staging implementation, not the production Postgres/indexer rollout.

Remote services use HTTPS and separate credentials mounted as files:

```dotenv
SHORTS_IPFS_API=https://services.example.com:8443/api/v0
SHORTS_IPFS_TOKEN_FILE=/run/secrets/shorts-ipfs-write
SHORTS_MODERATION_URL=https://services.example.com/moderation
SHORTS_MODERATION_TOKEN_FILE=/run/secrets/shorts-moderation
SHORTS_STREAM_INTERNAL_URL=https://services.example.com
SHORTS_STREAM_KEY_FILE=/run/secrets/shorts-streaming
```

Only the API receives these keys. The web app receives public API/playback URLs,
never service credentials. Point the streaming service's `STREAM_CATALOG_URL`
to this API's `/api/shorts` endpoint. Allow backend egress to the service server
and testnet node. Use a persistent volume and backups for the Shorts data directory.
The operator key is limited to testnet publication; viewer payments remain wallet-signed.
Configure normal ingress limits for uploads (40 MiB), API rate limits and HTTPS.

## Run locally

Requires Node 22.13+, FFmpeg/FFprobe on PATH, Docker, and the sibling `superhero-shorts-contract`, `superhero-ipfs` and `superhero-video-moderation` repositories. Compile/deploy that repository with its documented disposable testnet accounts first.

1. Install this API's normal dependencies (`npm ci` in an independent checkout).
2. Copy `src/shorts/shorts.env.example` to `.env.shorts-testnet`. Set absolute external paths to the operator-only key, deployment receipt and compiled contract artifact. Never supply creator or viewer private keys to the API.
3. Run `make start` inside `superhero-ipfs` for one offline Kubo node. For authenticated remote storage, use that repository's `make setup` and deployment guide: set `SHORTS_IPFS_API` to its HTTPS `/api/v0` URL and `SHORTS_IPFS_TOKEN_FILE` to the absolute path of its mounted 64-hex-character key. No endpoint list or credential-mapping JSON is needed. Remote plaintext URLs, missing credentials and redirects are rejected; keys stay server-side and are reloaded per request for rotation. This does not remove this bootstrap's local/testnet restrictions. Follow `superhero-video-moderation/README.md` to create a private service token and run `docker compose up --build -d` there. Set `SHORTS_MODERATION_URL` and `SHORTS_MODERATION_TOKEN_FILE` in the API environment.
4. Run `npm run start:shorts:testnet`.
5. In the web checkout, run `npm run start:shorts:testnet` and open `http://127.0.0.1:5180/shorts`.

API: `http://127.0.0.1:3334/api/shorts/config`. OpenAPI route listing: `/api/docs`. IPFS RPC: loopback 35002; debug gateway: loopback 38081. Visual inference: loopback 3340. All services bind to loopback. The normal API mounts this module only when `ENABLE_SHORTS=true`.

## Storage configuration migration

Replace `SHORTS_IPFS_APIS` with `SHORTS_IPFS_API` using the retained storage endpoint. Replace `SHORTS_IPFS_CREDENTIALS_FILE` with `SHORTS_IPFS_TOKEN_FILE` pointing directly to that endpoint's existing key. Remove the old variables; startup rejects them to prevent silently switching storage or disabling authentication. Local development may omit the key only for a loopback HTTP/HTTPS endpoint outside production. For a private CA, set `NODE_EXTRA_CA_CERTS` before starting Node.

Keep the original storage volume and verify its pin inventory before stopping any old replica. The IPFS repository documents this migration. A second copy, if introduced later, must be managed by the storage infrastructure behind the same API endpoint.

## Consumer and creator workflow

Watch without a wallet. Connect a wallet configured for æternity testnet and sign the one-time sign-in challenge to upload or open private creator information. Reporting needs no wallet. Use the official testnet faucet to fund your own test wallet. Signing in does not transfer tokens.

Upload an owned MP4/MOV clip (2–60 seconds, 40 MiB input maximum), title, topic, language, optional description/WebVTT captions, disclosures and rights confirmation. The web client sends resumable 1 MiB parts with an authenticated, 24-hour upload session. Parts are encrypted with the quarantine key; the full SHA-256 is checked before preparation. Reselect the same file and details to resume. Completing a session is idempotent. Stale part cleanup runs at startup and when starting another upload. The API prepares a single 540×960 MP4, poster and manifest, and measures the exact package bytes. Drafts remain private until Publish. The configured content policy separately determines feed eligibility.

Operator review can use the web Moderation tab when signed in with the operator wallet. On the local machine, the operator-only console provides the same authenticated review actions:

```sh
npm run shorts:review -- list
npm run shorts:review -- approve <short-id>
npm run shorts:review -- restrict <short-id>
```

The upload flow is Video → Details → Review → Publish. `POST /api/shorts/:id/publish` checks the creator session, persists publication intent, pins and verifies the complete package through the single IPFS endpoint, then calls the operator-only `publish` contract entrypoint. Superhero pays storage and registration gas. The creator pays nothing and receives no publication wallet transaction. There are no hosting quotes, budgets, periods, top-ups, expiry dates or reward allocations. Retries are idempotent; the worker resumes saved publication intent after interruption.

Each Like requires a wallet-confirmed 0.1 test AE payment, split 80/20 between creator and deployer treasury. Gas is additional. Claims transfer accrued rewards to the signing wallet. A withdrawal requires explicit confirmation, stops official playback permanently and cannot erase third-party copies.

## Trust and persistence

- API signing authority is restricted to publishing verified storage packages. User payments, reward claims and withdrawals require the user's wallet.
- Startup verifies `ae_uat`, the configured operator, contract address and bytecode fingerprint.
- Wallet sessions use random, single-use five-minute signature challenges and 30-minute bearer tokens. Only token hashes are stored. Sessions and metadata survive restart in a local SQLite WAL database.
- The worker retries pending publications every minute and at startup. Only an explicit publish request or a previously registered video creates that intent; private drafts never publish automatically.
- Existing registered videos migrate from a verified previous contract without expiry. Previously withdrawn videos remain withdrawn. Old rewards stay claimable on the previous contract and are exposed separately; old hosting funds are left untouched in that immutable contract.
- Private source/prepared media is encrypted at rest with AES-256-GCM and a local key. Published IPFS packages are plaintext for public free viewing, independently of feed approval. Losing the local encryption key makes private files unrecoverable.
- One offline Kubo node pins public packages. Playback verifies the returned bytes; the worker restores missing published pins from retained encrypted packages. Replication is not an API responsibility. The contract/CID and test transactions are public on testnet; the videos are not broadcast to the public IPFS swarm by this setup.
- Publication verifies full package hashes; the separate streaming worker creates and pins HLS segments from the trusted IPFS source. Publication enqueues preparation through a durable outbox. Published, non-withdrawn videos remain available without a hosting deadline. Feed inclusion additionally requires the configured content policy. `GET /api/shorts/shared/:id` resolves published videos outside the feed with a content warning when appropriate. The warning is presentation, not access control. The worker unpins withdrawn content and unpublished packages while preserving shared CIDs and uncertain submissions. Unpinning cannot erase cached/third-party copies or encrypted local source files.

## Tests

The standalone contract repository contains local-chain accounting/authorization tests. This API contains an opt-in testnet suite. It uses externally supplied disposable accounts and an owned video; it writes actual testnet transactions and leaves sample records in the local API.

```sh
SHORTS_TESTNET_E2E=1 \
SHORTS_TEST_KEYS_FILE=/absolute/private/shorts/test-accounts.json \
SHORTS_TEST_VIDEO=/absolute/path/owned-sample.mp4 \
npm run test:shorts:testnet
```

The operator in the supplied test accounts must match the configured contract. Run full API lint with `npm run lint` and typecheck with `npx tsc --noEmit`.

## MVP boundaries

One IPFS node (storage outages interrupt uploads/playback; persistent-volume backups are required), single-process SQLite snapshot persistence, a 50-video limit, buffered upload media, no production indexing/backfill or provider SLA. Reconciliation trusts the operator's retrieval attestation; it is not a decentralized proof of storage.

Topic suggestions can use the optional JEV adapter below. Operators review and correct the discovery topic separately from immutable package metadata; decisions and appeals remain in local review history. Sampled visual screening is implemented below; representative safety evaluation, audio checks, age/territory controls and fraud-resistant analytics remain release work. Playback metrics are client reports from browsers, not verified people. Official moderation cannot prevent direct contract transactions or erase public chain/IPFS records. Wallet/store policy approval, production security and contract audit remain separate release work.


## Studio and analytics

Creator routes live under `/shorts/studio` with content, analytics, revenue, upload and per-video pages. `/performance?days=7|28|90&short=<optional-id>` requires a creator session and checks video ownership. Live reward balances are always separate from the selected reporting window. Every playback summary (current, previous, daily and per-video) exposes `views`, `watchSeconds`, `watchHours`, `averageSeconds` and `completion`. `watchHours = watchSeconds / 3600` is returned without presentation rounding. Only qualified views contribute watch time; repeated segments are excluded, capped at one clip duration per browser/Short/UTC day. These are reporting-window totals, with up to 90 days of retained measurements.

Playback is counted automatically without an opt-in control, including for guests. Actual playback starts with a zero-second event and sends cumulative unique playback time. The browser merges watched intervals and excludes repeated segments, seeks, paused, buffered and background playback; the server bounds reports by clip duration and time since the first event. SQLite stores a salted browser identifier, never a wallet address, for up to 90 days. A view requires two seconds; repeated loops are capped at clip duration and deduplicated per browser/Short/UTC day. Reach is distinct browsers within the requested creator scope. Source breakdowns need five browsers. Reports mark partial collection windows, including prior periods beyond retention, and never invent historical watch time. `/analytics/forget` removes the current browser's retained measurements and subtracts their qualified views. A salted revocation digest expires after 24 hours to reject late requests from that deleted session. Public `views` and Studio reports use the same qualified events. Anonymous lifetime view totals survive the 90-day expiry of browser records; only retained records can be removed by browser deletion. Existing qualified analytics rows migrate once, while legacy unmeasured preview views are excluded. The legacy `/:id/view` endpoint now only reads counters. These controls do not provide Sybil resistance.

For You receives a bounded engagement score from the last seven days: 70% watched fraction and 30% completion, averaged per browser before aggregation. Scores stay neutral below five distinct browsers and use twenty neutral prior browsers to temper small samples. The web client combines this with interests, follows, freshness and creator diversity. Recent stays chronological. Paid Likes, rewards and wallet balances never influence engagement scoring.

The bounded testnet ledger rebuilds up to 2,000 middleware logs, verifies successful calls and canonical microblocks against the node, then atomically replaces its SQLite snapshot. It requires three key-block confirmations, deduplicates by transaction/event index and exposes stale state if an upstream read fails. It refreshes each minute; a coherent rebuild removes orphaned entries. This is a local prototype indexer, not a production finality or reconciliation guarantee.

Anonymous reports use bounded reason/detail fields and idempotency IDs. Creator-only appeals and operator-only review decisions are stored locally. Broader abuse prevention, policy staffing and legally complete notice/appeal workflows need production design.

## Optional TypeSafe JEV

Leave `SHORTS_JEV_ENABLED=0` until configured. Enable only with a server-side `TYPESAFE_API_KEY` and a pinned `SHORTS_JEV_MODEL=jev-x.y.z`. The adapter sends title, declared topic, description and optional creator captions to `https://api.typesafe.ai/v1/systemone`. It checks the returned version, taxonomy, confidence and output shape; uncertain or failed results fall back to manual review. Evidence hashes, taxonomy and rubric versions are retained. No viewing history or wallet data is sent. There is no raw video/audio analysis, ASR/OCR pipeline or automatic safety approval. Operators choose the final discovery topic; client matching uses that topic and local preferences.

Run `npm run test:shorts:unit` for offline analytics, privacy, JEV fallback, ownership, appeals, indexer and resumable-upload tests. The opt-in testnet suite exercises resumable transfer, private drafts, operator-funded publication, verified playback, exact Like splitting, claims and withdrawal. It verifies that publishing leaves the creator balance unchanged.

## Local Studio connection without an extra signature

Set `SHORTS_DEMO_CONNECTED_WALLET=1` in the ignored local environment and restart the API to use the main app's connected address throughout Studio. The config endpoint reports `creatorAccess: "connected-wallet"`; the web client opens and renews its Studio session automatically through `POST /api/shorts/auth/connect`. Switching or disconnecting the main wallet clears the previous account's creator data. Paid Likes, claims and withdrawals still require wallet-signed contract calls.

This is a local demo identity shortcut, not cryptographic proof of address ownership. A local caller can request a creator session for any valid address, including access to that address's drafts and analytics. It is disabled by default, requires local testnet mode and is unavailable in production. Hosted startup rejects this shortcut. Connection-only sessions expire after 30 minutes, are stored separately, cannot access operator review routes and stop working when the flag is disabled. Outside this mode, private creator access still uses signed sessions.

## Temporary local demo approval

Set `SHORTS_DEMO_AUTO_APPROVE=1` in the ignored `.env.shorts-testnet` and restart the local API to skip visual scans, scan retries and optional text classification. This opt-in mode requires `SHORTS_TESTNET_MVP=1` and is disabled in production. The config endpoint reports `moderationMode: "demo"` and `visualModeration: false`.

New uploads and existing pending videos become eligible for the feed immediately. Publication is still required for playback and feed inclusion; withdrawn and private draft videos remain unavailable. Previously blocked or explicitly rejected videos remain excluded. Wallet authorization, media validation, encryption, IPFS verification and payment checks are unchanged.

Approval is an effective demo policy, not a stored review decision: creator responses report `moderation: "approved"` and `guidelines.approval: "demo"`, without manufacturing scan evidence or overwriting review history. The web UI omits the community-guidelines check panel for these responses. Set the flag back to `0` and restart to restore the original review state; uploads created during the demo then need inspection and approval. The worker resumes scanning missing or failed evidence automatically.

## Local visual inspection (default mode)

Every upload sends the actual original bytes to the local Docker visual service before review. It samples two frames per second, scene changes and a final frame; Falconsai NSFW screens sexual/nudity content and OpenAI CLIP suggests visual topics. JEV is not involved in this visual pipeline and may remain disabled. The receipt binds model/policy versions, timestamps, image scores and topic suggestions to the original SHA-256. The API rejects malformed evidence, incomplete temporal coverage and inconsistent decisions.

Missing, failed or blocked scans cannot be approved for the feed. Publication, pin repair and direct-link playback are independent of that decision. Feed inclusion still requires human review. A gray-zone score additionally requires an explicit full-video review checkbox and reason; the decision binds to that exact evidence hash. The operator and creator can request another scan from Studio. Existing records without receipts are scanned by the recovery worker; failed scans retry after at least a minute. A re-scan that requires review removes feed eligibility until reviewed again, while preserving publication and storage. Creator responses contain a community-guidelines summary; technical frames, scores, review history and model/classification evidence are returned only by authenticated operator routes.

Sampled frames can miss brief content, and model scores have false positives/negatives. Initial thresholds require representative evaluation; this does not certify a pornography-free service or detect every illegal category. The model service has no signing, publication or IPFS authority.

## Upgrading an existing local deployment

Back up the SQLite database, previous artifact and deployment receipt before switching. Deploy the contract with `SHORTS_PREVIOUS_CONTRACT` set to the previous address. Point `SHORTS_DEPLOYMENT_FILE` and `SHORTS_CONTRACT_ARTIFACT` to the new deployment/artifact, and supply `SHORTS_PREVIOUS_DEPLOYMENT_FILE` plus `SHORTS_PREVIOUS_CONTRACT_ARTIFACT` for the verified old deployment. These paths and private keys stay outside Git.

Startup verifies both contracts, imports only records already registered on the old contract, and queues operator-funded publication. A stored registry for an unrelated contract is rejected. Prior Like counts and duplicate-Like protection carry forward. The bounded ledger reads verified Like/claim events from both contracts; Studio shows the earlier claimable balance separately. No hosting funds or rewards are moved by migration.

## Separate public playback

Public media is delivered by `superhero-video-streaming`, not this API. Start that repository with `make start`. Feed/Studio records return IDs, metadata and a `captions` boolean; they no longer return API media URLs. `GET /api/shorts/playback/:id` returns only the published CID and allowlisted file names/sizes/hashes. It checks the current on-chain owner, CID, byte count and withdrawal state, and never exposes a draft. Feed eligibility remains separate from published direct-link availability. The old `/media/:id/:file` route returns 410. Private authenticated review previews and upload-time full-file IPFS verification remain in this module. Testnet lifecycle tests use `SHORTS_STREAM_URL` (default `http://127.0.0.1:3335`) for playback. The service provides expiring HLS playlists and segments; its former full-MP4 route returns 410. It prepares existing videos without changing their contract CID. Original and prepared HLS packages are pinned in IPFS. Playback caches are disposable; eviction does not require transcoding again. Configure SHORTS_STREAM_INTERNAL_URL and SHORTS_STREAM_KEY_FILE for the private authenticated preparation endpoint. The API publication outbox retries failed delivery and backfills published records after restart. The streaming service caches publication descriptors for a fixed 15 seconds by default; withdrawal can take that long to reach playback, including edge cache hits. SHORTS_STREAM_URL remains the test client’s public playback URL.

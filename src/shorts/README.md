# Shorts testnet MVP

A local NestJS feature module connected to a real æternity testnet contract. It is started separately from the full application so the MVP does not require production databases, relays or credentials. The web feature runs within Superhero's existing application and wallet providers.

## Run locally

Requires Node 22.13+, FFmpeg/FFprobe on PATH, Docker, and the sibling `superhero-shorts-contract`, `superhero-ipfs` and `superhero-video-moderation` repositories. Compile/deploy that repository with its documented disposable testnet accounts first.

1. Install this API's normal dependencies (`npm ci` in an independent checkout).
2. Copy `src/shorts/shorts.env.example` to `.env.shorts-testnet`. Set absolute external paths to the operator-only key, deployment receipt and compiled contract artifact. Never supply creator or viewer private keys to the API.
3. Run `docker compose up -d` inside `superhero-ipfs` for the two offline Kubo nodes. Follow `superhero-video-moderation/README.md` to create a private service token and run `docker compose up --build -d` there. Set `SHORTS_IPFS_APIS`, `SHORTS_MODERATION_URL` and `SHORTS_MODERATION_TOKEN_FILE` in the API environment.
4. Run `npm run start:shorts:testnet`.
5. In the web checkout, run `npm run start:shorts:testnet` and open `http://127.0.0.1:5180/shorts`.

API: `http://127.0.0.1:3334/api/shorts/config`. OpenAPI route listing: `/api/docs`. IPFS RPCs: loopback 35002/35003; gateways: loopback 38081/38082. Visual inference: loopback 3340. All services bind to loopback. The normal API bootstrap does not mount this module.

## Consumer and creator workflow

Watch without a wallet. Connect a wallet configured for æternity testnet and sign the one-time sign-in challenge to upload or open private creator information. Reporting needs no wallet. Use the official testnet faucet to fund your own test wallet. Signing in does not transfer tokens.

Upload an owned MP4/MOV clip (2–60 seconds, 40 MiB input maximum), title, topic, language, optional description/WebVTT captions, disclosures and rights confirmation. The web client sends resumable 1 MiB parts with an authenticated, 24-hour upload session. Parts are encrypted with the quarantine key; the full SHA-256 is checked before preparation. Reselect the same file and details to resume. Completing a session is idempotent. Stale part cleanup runs at startup and when starting another upload. The API prepares a single 540×960 MP4, poster and manifest, and measures the exact package bytes. Drafts remain private until paid hosting activates. Operator review separately determines feed eligibility.

Operator review can use the web Moderation tab when signed in with the operator wallet. On the local machine, the operator-only console provides the same authenticated review actions:

```sh
npm run shorts:review -- list
npm run shorts:review -- approve <short-id>
npm run shorts:review -- restrict <short-id>
```

After preparation, the creator chooses a hosting budget and wallet or reward source. The API registers an exact price/size/term/CID quote on chain. The creator's wallet signs funding; the API verifies the complete package on both configured IPFS nodes before activating coverage. Feed approval is not required to purchase hosting or share a paid active video by direct link. Studio displays the coverage end date, claimable rewards, earnings, views, paid Likes and transaction links. Creators can buy additional days using their available rewards or wallet balance.

The upload stepper also supports a duration-first choice. Authenticated `GET /api/shorts/:id/hosting-prices` checks creator ownership and returns the prepared byte size and current tariff numerator/denominator without registering a quote. `POST /api/shorts/quote` accepts exactly one of `budget` (AE string) or `days` (integer, 1–3650), alongside `shortId` and `source`. The existing contract performs final rounded-up pricing when the quote is registered; the response remains the authoritative payment amount and expiry. No contract deployment change is required.

Each Like requires a wallet-confirmed 0.1 test AE payment, split 80/20 between creator and deployer treasury. Gas is additional. Claims transfer accrued rewards to the signing wallet. A withdrawal requires explicit confirmation, stops official playback permanently and does not refund activated hosting.

## Trust and persistence

- API signing authority is restricted to registering quotes and activating storage. User payments, reward claims and withdrawals require the user's wallet.
- Startup verifies `ae_uat`, the configured operator, contract address and bytecode fingerprint.
- Wallet sessions use random, single-use five-minute signature challenges and 30-minute bearer tokens. Only token hashes are stored. Sessions and metadata survive restart in a local SQLite WAL database.
- The worker checks on-chain pending purchases every minute and at startup. A wallet can fund while the API is offline; the worker activates after recovery, if the activation deadline still permits it. If activation fails past the deadline, the creator can call `refund_failed` to restore the original funding source.
- Initial/restored coverage begins after activation. Extensions append purchased days. Tariff changes cannot shorten existing coverage.
- Private source/prepared media is encrypted at rest with AES-256-GCM and a local key. Paid public IPFS packages are plaintext for public free viewing, independently of feed approval. Losing the local encryption key makes private files unrecoverable.
- The two offline Kubo nodes pin public packages locally. Verified playback falls back between nodes; the worker repairs missing paid replicas. The contract/CID and test transactions are public on testnet; the videos are not broadcast to the public IPFS swarm by this setup.
- Playback verifies package hashes. Byte ranges are supported. Expired or withdrawn videos are unavailable through the media API. Feed inclusion additionally requires moderation approval and valid visual evidence. Paid active videos remain available at `GET /api/shorts/shared/:id` and through the media API even when excluded from the feed; the shared response includes `contentWarning` for the player’s blurred click-to-view cover. This cover is presentation, not access control. The worker unpins expired, withdrawn or unfunded content while preserving CIDs shared by paid active videos. Unpinning does not erase cached/third-party copies or the encrypted local source.

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

Two local IPFS replicas sharing one host, single-process SQLite snapshot persistence, a 50-video limit, buffered media, no HLS/CDN, no production indexing/backfill or provider SLA. Reconciliation trusts the operator's retrieval attestation; it is not a decentralized proof of storage. Storage escrow settlement is exposed by the contract but is not automatically batched by this API.

Topic suggestions can use the optional JEV adapter below. Operators review and correct the discovery topic separately from immutable package metadata; decisions and appeals remain in local review history. Sampled visual screening is implemented below; representative safety evaluation, audio checks, age/territory controls and fraud-resistant analytics remain release work. Playback metrics are client reports from consenting browsers, not verified people. Official moderation cannot prevent direct contract transactions or erase public chain/IPFS records. Wallet/store policy approval, production security and contract audit remain separate release work.


## Studio and analytics

Creator routes live under `/shorts/studio` with content, analytics, revenue, hosting, upload and per-video pages. `/performance?days=7|28|90&short=<optional-id>` requires a creator session and checks video ownership. Live reward balances are always separate from the selected reporting window.

Opted-in playback starts with a zero-second event and sends cumulative actual watch time. SQLite stores a salted browser identifier, never a wallet address, for up to 90 days. A view requires two seconds; repeated loops are capped at clip duration and deduplicated per browser/Short/UTC day. Reach is distinct browsers within the requested creator scope. Source breakdowns need five browsers. Reports mark partial collection windows, including prior periods beyond retention, and never invent historical watch time. `/analytics/forget` removes the current browser's measurements. These controls do not provide Sybil resistance.

The bounded testnet ledger rebuilds up to 2,000 middleware logs, verifies successful calls and canonical microblocks against the node, then atomically replaces its SQLite snapshot. It requires three key-block confirmations, deduplicates by transaction/event index and exposes stale state if an upstream read fails. It refreshes each minute; a coherent rebuild removes orphaned entries. This is a local prototype indexer, not a production finality or reconciliation guarantee.

Anonymous reports use bounded reason/detail fields and idempotency IDs. Creator-only appeals and operator-only review decisions are stored locally. Broader abuse prevention, policy staffing and legally complete notice/appeal workflows need production design.

## Optional TypeSafe JEV

Leave `SHORTS_JEV_ENABLED=0` until configured. Enable only with a server-side `TYPESAFE_API_KEY` and a pinned `SHORTS_JEV_MODEL=jev-x.y.z`. The adapter sends title, declared topic, description and optional creator captions to `https://api.typesafe.ai/v1/systemone`. It checks the returned version, taxonomy, confidence and output shape; uncertain or failed results fall back to manual review. Evidence hashes, taxonomy and rubric versions are retained. No viewing history or wallet data is sent. There is no raw video/audio analysis, ASR/OCR pipeline or automatic safety approval. Operators choose the final discovery topic; client matching uses that topic and local preferences.

Run `npm run test:shorts:unit` for offline analytics, privacy, JEV fallback, ownership, appeals, indexer and resumable-upload tests. The opt-in testnet suite additionally exercises resumable transfer, captions retrieval, analytics deletion and moderation/appeals alongside the wallet lifecycle.

## Local Studio connection without an extra signature

Set `SHORTS_DEMO_CONNECTED_WALLET=1` in the ignored local environment and restart the API to use the main app's connected address throughout Studio. The config endpoint reports `creatorAccess: "connected-wallet"`; the web client opens and renews its Studio session automatically through `POST /api/shorts/auth/connect`. Switching or disconnecting the main wallet clears the previous account's creator data. Hosting payments, paid Likes, claims and withdrawals still require wallet-signed contract calls.

This is a local demo identity shortcut, not cryptographic proof of address ownership. A local caller can request a creator session for any valid address, including access to that address's drafts and analytics. It is disabled by default, requires local testnet mode and is unavailable in production. The normal API bootstrap does not expose the Shorts module. Connection-only sessions expire after 30 minutes, are stored separately, cannot access operator review routes and stop working when the flag is disabled. Outside this mode, private creator access still uses signed sessions.

## Temporary local demo approval

Set `SHORTS_DEMO_AUTO_APPROVE=1` in the ignored `.env.shorts-testnet` and restart the local API to skip visual scans, scan retries and optional text classification. This opt-in mode requires `SHORTS_TESTNET_MVP=1` and is disabled in production. The config endpoint reports `moderationMode: "demo"` and `visualModeration: false`.

New uploads and existing pending videos become eligible for the feed immediately. Paid active hosting is still required for playback and feed inclusion; expired, withdrawn and unfunded videos remain unavailable. Previously blocked or explicitly rejected videos remain excluded. Wallet authorization, media validation, encryption, IPFS verification and payment checks are unchanged.

Approval is an effective demo policy, not a stored review decision: creator responses report `moderation: "approved"` and `guidelines.approval: "demo"`, without manufacturing scan evidence or overwriting review history. The web UI omits the community-guidelines check panel for these responses. Set the flag back to `0` and restart to restore the original review state; uploads created during the demo then need inspection and approval. The worker resumes scanning missing or failed evidence automatically.

## Local visual inspection (default mode)

Every upload sends the actual original bytes to the local Docker visual service before review. It samples two frames per second, scene changes and a final frame; Falconsai NSFW screens sexual/nudity content and OpenAI CLIP suggests visual topics. JEV is not involved in this visual pipeline and may remain disabled. The receipt binds model/policy versions, timestamps, image scores and topic suggestions to the original SHA-256. The API rejects malformed evidence, incomplete temporal coverage and inconsistent decisions.

Missing, failed or blocked scans cannot be approved for the feed. Hosting quotes, activation, repair and paid direct-link playback are independent of that decision. Feed inclusion still requires human review. A gray-zone score additionally requires an explicit full-video review checkbox and reason; the decision binds to that exact evidence hash. The operator and creator can request another scan from Studio. Existing records without receipts are scanned by the recovery worker; failed scans retry after at least a minute. A re-scan that requires review removes feed eligibility until reviewed again, while preserving paid coverage. Creator responses contain a community-guidelines summary; technical frames, scores, review history and model/classification evidence are returned only by authenticated operator routes.

Sampled frames can miss brief content, and model scores have false positives/negatives. Initial thresholds require representative evaluation; this does not certify a pornography-free service or detect every illegal category. The model service has no signing, publication or IPFS authority.

# Address Links -- Frontend Implementation Guide

Guide for frontend and mobile app developers integrating with the address-links API. Covers account checking, the claim/submit flow, AE wallet signing, and provider-specific details for Nostr and X.

## Account link check

Check whether a user's account already has links by fetching their account:

```
GET /accounts/:address
```

Response:

```json
{
  "address": "ak_2Qktt...",
  "links": {
    "nostr": "npub1xyzabc...",
    "x": "superherocom"
  }
}
```

- If `links` is `{}` or a specific provider key is absent, the user has no link for that provider.
- A 404 means the account doesn't exist on the backend yet -- treat as "no link".

## Linking flow overview

Every provider follows the same two-step pattern:

```
1. Claim  -->  backend returns { message, nonce, value }
2. Sign the message with AE wallet + create provider proof
3. Submit  -->  backend broadcasts tx, returns { txHash }
```

## AE wallet signing

All providers require the user to sign the claim message with their AE wallet. The on-chain contract verifies against a specific 60-byte digest format.

**Use `unsafeSign`, not `signMessage`.** The SDK's `signMessage()` produces a different digest.

```typescript
import { hash } from '@aeternity/aepp-sdk';
import { Buffer } from 'buffer';

const AE_MESSAGE_PREFIX = new Uint8Array([
  0x1a, 0x61, 0x65, 0x74, 0x65, 0x72, 0x6e, 0x69, 0x74, 0x79,
  0x20, 0x53, 0x69, 0x67, 0x6e, 0x65, 0x64, 0x20, 0x4d, 0x65,
  0x73, 0x73, 0x61, 0x67, 0x65, 0x3a, 0x0a, 0x20,
]);

function buildContractDigest(message: string): Uint8Array {
  const msgHash = hash(Buffer.from(message, 'utf-8')); // blake2b_256 -> 32 bytes
  const digest = new Uint8Array(AE_MESSAGE_PREFIX.length + msgHash.length);
  digest.set(AE_MESSAGE_PREFIX);
  digest.set(msgHash, AE_MESSAGE_PREFIX.length);
  return digest; // 28 + 32 = 60 bytes
}

async function signWithAeWallet(aeAccount: any, message: string): Promise<string> {
  const digest = buildContractDigest(message);
  const sig = await aeAccount.unsafeSign(digest);
  return Buffer.from(sig).toString('hex'); // 128-char hex string
}
```

The resulting `signature` is a **128-character lowercase hex string** (64 bytes). No `0x` prefix. No base64.

---

## Nostr

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/address-links/nostr/claim` | Get message to sign |
| POST | `/address-links/nostr/submit` | Submit signatures |
| POST | `/address-links/nostr/unclaim` | Get unlink message |
| POST | `/address-links/nostr/unclaim/submit` | Submit unlink signature |

### Claim

```
POST /address-links/nostr/claim
```

```json
{
  "address": "ak_2Qktt...",
  "value": "npub1xyzabc..."
}
```

Response:

```json
{
  "message": "link:ak_2Qktt...:nostr:npub1xyzabc...:0",
  "nonce": 0,
  "value": "npub1xyzabc..."
}
```

| Error | Reason |
|---|---|
| 400 | `address` missing |
| 400 | `value` missing or invalid npub format |

### Submit

```
POST /address-links/nostr/submit
```

```json
{
  "address": "ak_2Qktt...",
  "value": "npub1xyzabc...",
  "nonce": 0,
  "signature": "ab12cd34...hex...",
  "nostr_event": "{\"id\":\"...\",\"pubkey\":\"...\",\"created_at\":...,\"kind\":22242,\"tags\":[],\"content\":\"link:ak_...:nostr:npub1...:0\",\"sig\":\"...\"}"
}
```

All fields are **required**.

Response:

```json
{
  "txHash": "th_2abc..."
}
```

| Error | Reason |
|---|---|
| 400 | `nostr_event` missing or invalid JSON |
| 400 | Event `kind` is not `22242` |
| 400 | Event `content` doesn't match expected link message |
| 400 | Event `pubkey` doesn't match the claimed npub |
| 400 | Event signature is invalid |
| 400 | Event timestamp too old (>5 min) or in the future (>60s) |
| 400 | Wallet signature verification failed |
| 400 | Nonce mismatch |

### Nostr proof event

The backend requires a signed Nostr event as proof of key ownership:

| Field | Requirement |
|---|---|
| `kind` | `22242` (NIP-42 auth event) |
| `content` | Exact `message` string from the claim response |
| `pubkey` | Hex public key that matches the claimed `npub` |
| `created_at` | Within 300 seconds of server time |
| `sig` | Valid Schnorr signature |
| `tags` | Can be empty `[]` |

```typescript
import { finalizeEvent, type UnsignedEvent } from 'nostr-tools';

function createNostrProofEvent(message: string, nostrSecretKeyHex: string): string {
  const secretKeyBytes = Uint8Array.from(Buffer.from(nostrSecretKeyHex, 'hex'));

  const unsignedEvent: UnsignedEvent = {
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: message,
  };

  const signedEvent = finalizeEvent(unsignedEvent, secretKeyBytes);
  return JSON.stringify(signedEvent);
}
```

Create the event **fresh** right before submitting. Do not cache or reuse events.

### Full Nostr linking flow

```typescript
async function linkNostr(apiBase: string, aeAccount: any, mnemonic: string): Promise<string> {
  const address = aeAccount.address;
  const nostrKeys = deriveNostrKeysFromMnemonic(mnemonic);

  // 1. Claim
  const res = await fetch(`${apiBase}/address-links/nostr/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, value: nostrKeys.npub }),
  });
  const claim = await res.json();

  // 2. Sign with AE wallet
  const aeSignature = await signWithAeWallet(aeAccount, claim.message);

  // 3. Create Nostr proof event
  const nostrEventJson = createNostrProofEvent(claim.message, nostrKeys.secretKeyHex);

  // 4. Submit
  const submitRes = await fetch(`${apiBase}/address-links/nostr/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address,
      value: nostrKeys.npub,
      nonce: claim.nonce,
      signature: aeSignature,
      nostr_event: nostrEventJson,
    }),
  });
  const { txHash } = await submitRes.json();
  return txHash;
}
```

### Unclaim / Unlink

```
POST /address-links/nostr/unclaim
{ "address": "ak_2Qktt..." }

Response: { "message": "unlink:ak_2Qktt...:nostr:1", "nonce": 1 }
```

```
POST /address-links/nostr/unclaim/submit
{ "address": "ak_2Qktt...", "nonce": 1, "signature": "ab12cd34...hex..." }

Response: { "txHash": "th_..." }
```

---

## X (Twitter)

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/address-links/x/claim` | Verify X ownership via OAuth, get message to sign |
| POST | `/address-links/x/submit` | Submit AE signature + verification token |
| POST | `/address-links/x/unclaim` | Get unlink message |
| POST | `/address-links/x/unclaim/submit` | Submit unlink signature |

### Claim

```
POST /address-links/x/claim
```

Option A -- with access token:

```json
{
  "address": "ak_2Qktt...",
  "x_access_token": "..."
}
```

Option B -- with OAuth code:

```json
{
  "address": "ak_2Qktt...",
  "x_code": "...",
  "x_code_verifier": "...",
  "x_redirect_uri": "..."
}
```

Response:

```json
{
  "message": "link:ak_2Qktt...:x:superherocom:0",
  "nonce": 0,
  "value": "superherocom",
  "verification_token": "eyJ..."
}
```

The `verification_token` is a server-signed HMAC token. Save it -- you need it for submit.

| Error | Reason |
|---|---|
| 400 | Neither `x_access_token` nor OAuth code fields provided |
| 400 | Unable to extract X username from OAuth profile |

### Submit

```
POST /address-links/x/submit
```

```json
{
  "address": "ak_2Qktt...",
  "value": "superherocom",
  "nonce": 0,
  "signature": "ab12cd34...hex...",
  "verification_token": "eyJ..."
}
```

All fields are **required**.

Response:

```json
{
  "txHash": "th_2abc..."
}
```

| Error | Reason |
|---|---|
| 400 | `verification_token` missing |
| 400 | Verification token expired (default 5 min TTL) |
| 400 | Token address, provider, or value mismatch |
| 400 | Invalid token signature |
| 400 | Wallet signature verification failed |

### Full X linking flow

```typescript
async function linkX(apiBase: string, aeAccount: any, xAccessToken: string): Promise<string> {
  const address = aeAccount.address;

  // 1. Claim (backend verifies X ownership via OAuth)
  const res = await fetch(`${apiBase}/address-links/x/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, x_access_token: xAccessToken }),
  });
  const claim = await res.json();

  // 2. Sign with AE wallet
  const aeSignature = await signWithAeWallet(aeAccount, claim.message);

  // 3. Submit with verification token from claim
  const submitRes = await fetch(`${apiBase}/address-links/x/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address,
      value: claim.value,
      nonce: claim.nonce,
      signature: aeSignature,
      verification_token: claim.verification_token,
    }),
  });
  const { txHash } = await submitRes.json();
  return txHash;
}
```

### Unclaim / Unlink

Same pattern as Nostr:

```
POST /address-links/x/unclaim
{ "address": "ak_2Qktt..." }

POST /address-links/x/unclaim/submit
{ "address": "ak_2Qktt...", "nonce": 1, "signature": "ab12cd34...hex..." }
```

---

## React Native / Expo integration

For mobile apps with wallet and Nostr key derivation from a BIP-39 mnemonic.

### Auto-link check on app launch

```typescript
type NostrLinkStatus = 'checking' | 'linked' | 'prompt' | 'linking' | 'done' | 'error';

export function useNostrLinkCheck(apiBase: string, wallet: { address: string } | null) {
  const [status, setStatus] = useState<NostrLinkStatus>('checking');
  const [error, setError] = useState<string | null>(null);
  const hasChecked = useRef(false);

  useEffect(() => {
    if (!wallet || hasChecked.current) return;
    hasChecked.current = true;

    (async () => {
      try {
        const res = await fetch(`${apiBase}/accounts/${wallet.address}`);
        if (!res.ok) {
          setStatus(res.status === 404 ? 'prompt' : 'error');
          return;
        }
        const account = await res.json();
        setStatus(account.links?.nostr ? 'linked' : 'prompt');
      } catch (err: any) {
        setError(err.message);
        setStatus('error');
      }
    })();
  }, [wallet, apiBase]);

  return { status, setStatus, error, setError };
}
```

### Dismiss persistence

Use AsyncStorage to avoid re-prompting:

```typescript
import AsyncStorage from '@react-native-async-storage/async-storage';

const DISMISSED_KEY = 'nostr_link_dismissed_at';
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

async function wasDismissedRecently(): Promise<boolean> {
  const val = await AsyncStorage.getItem(DISMISSED_KEY);
  if (!val) return false;
  return Date.now() - parseInt(val, 10) < COOLDOWN_MS;
}

async function markDismissed(): Promise<void> {
  await AsyncStorage.setItem(DISMISSED_KEY, String(Date.now()));
}
```

---

## Troubleshooting

### `"Wallet signature verification failed"`

The most common error. The contract rejected the Ed25519 signature.

**Check in order:**

1. **Signing method** -- Must use `unsafeSign(digest)`, not `signMessage(message)`.
2. **Digest length** -- Must be exactly 60 bytes (28-byte prefix + 32-byte blake2b hash). If it's 32, you're likely using `signMessage`.
3. **Hash function** -- Must be Blake2b-256 (from `@aeternity/aepp-sdk` `hash`), not SHA-256.
4. **Signature encoding** -- Must be 128-char lowercase hex. No `0x` prefix, no base64.
5. **Message** -- Must be the exact `message` string from the claim response. Don't reconstruct locally.
6. **Account** -- The signer must match the `address` in the request.

### `"Invalid signature: expected 128-character hex string"`

The `signature` field format is wrong:
- Must be exactly 128 hex characters (0-9, a-f)
- No `0x` prefix, no base64, no whitespace

### `"Nonce mismatch"`

The nonce changed between claim and submit (e.g. another link was made from a different device). Re-run from claim to get the current nonce.

### `"Nostr event content does not match expected link message"`

The `content` in the Nostr event doesn't match. Always use the exact `claim.message` string. Create the event fresh right before submitting.

### `"Nostr event timestamp is out of acceptable range"`

The event `created_at` is >300s old or >60s in the future. Create the event immediately before submission. Check the device clock.

### `"Verification token has expired"` (X)

The HMAC token from the X claim has expired (default 5 min). Re-run from claim.

### Debug helper (Nostr)

```typescript
async function linkNostrDebug(apiBase: string, aeAccount: any, mnemonic: string) {
  const nostrKeys = deriveNostrKeysFromMnemonic(mnemonic);
  console.log('[nostr-link] address:', aeAccount.address);
  console.log('[nostr-link] npub:', nostrKeys.npub);

  const claim = await claimNostrLink(apiBase, aeAccount.address, nostrKeys.npub);
  console.log('[nostr-link] message:', claim.message);

  const digest = buildContractDigest(claim.message);
  console.log('[nostr-link] digest length:', digest.length, '(MUST be 60)');

  const sig = await aeAccount.unsafeSign(digest);
  const aeSignature = Buffer.from(sig).toString('hex');
  console.log('[nostr-link] signature length:', aeSignature.length, '(expected 128)');

  const nostrEventJson = createNostrProofEvent(claim.message, nostrKeys.secretKeyHex);
  const event = JSON.parse(nostrEventJson);
  console.log('[nostr-link] event pubkey matches npub:', event.pubkey === nip19.decode(nostrKeys.npub).data);
  console.log('[nostr-link] event content matches message:', event.content === claim.message);

  const result = await submitNostrLink(apiBase, aeAccount.address, nostrKeys.npub, claim.nonce, aeSignature, nostrEventJson);
  console.log('[nostr-link] txHash:', result.txHash);
}
```

Key checks:
- `digest length` must be 60 (not 32)
- `signature length` must be 128
- Event pubkey must match npub
- Event content must match message

---

## Edge cases

| Scenario | Behavior |
|---|---|
| Account doesn't exist (404) | Treat as "no link". The backend creates the account row when the on-chain event is processed. |
| User dismisses prompt | Don't re-prompt during the session. Use AsyncStorage with a cooldown (e.g. 24h). |
| Link tx fails (500) | Retry from claim to get a fresh nonce. |
| Already linked from another device | `links.<provider>` will be present in the account response. |
| Wallet/mnemonic changes | Old identity stays linked on-chain. Must unlink the old one before re-linking with new keys. |
| Network offline | Fail gracefully. Retry on next app open. |

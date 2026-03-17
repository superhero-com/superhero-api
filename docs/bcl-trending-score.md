## Trending score algorithm for token ranking

We use a simple formula to rank tokens on the bonding curve platform based on recent activity and investment velocity:

#### Formula:

```
Trending Score = w1 * (Unique Transactions in 24h) + w2 * (Investment Volume in AE in 24h / Lifetime Minutes)
```

- Unique Transactions in 24h: Number of unique accounts that interacted with the token in the last 24 hours.
- Investment Volume in AE in 24h: Amount of AE invested in the last 24 hours.
- Lifetime Minutes: Minutes the token has existed within the last 24 hours (max 1440).

---

#### Weighting

Choose weights based on priority:

- w1 = 0.6 (transaction activity)
- w2 = 0.4 (investment speed)

Adjust as needed to balance engagement vs. capital flow.

These numbers should remain changeable in the backend at any time.

---

#### Normalization (Recommended)

To combine these metrics fairly:

1. Normalize both components using Min-Max Scaling:

   ```
   Normalized Value = (Value - Min) / (Max - Min)
   ```
2. Calculate:
   - Normalized Transactions
   - Normalized (Volume / Lifetime Minutes)
3. Final Trending Score:

   ```
   Trending Score = w1 * Normalized Transactions + w2 * Normalized Volume/Min
   ```

---

#### Fallback for 0 score tokens

For tokens in the trending list that have a ranking score of 0 we rank them by latest created.

---

#### Example

| Token   | Unique Tx (24h) | AE Volume | Lifetime Min |
|---------|-----------------|-----------|--------------|
| Token A | 100             | 500       | 60           |
| Token B | 50              | 800       | 1440         |
| Token C | 200             | 300       | 120          |

Volume per Minute:

- A: 8.33
- B: 0.56
- C: 2.5

Normalized (example range):

- Transactions: A = 0.33, B = 0.00, C = 1.00
- Volume/Min: A = 1.00, B = 0.22, C = 0.40

Scores (w1 = 0.6, w2 = 0.4):

- Token C: 0.6 \* 1.00 + 0.4 \* 0.40 = 0.76
- Token A: 0.6 \* 0.33 + 0.4 \* 1.00 = 0.60
- Token B: 0.6 \* 0.00 + 0.4 \* 0.22 = 0.09

Ranking:

1. Token C
2. Token A
3. Token B

---

## Guide: Changing, Tweaking, and Improving the Trending Algorithm

### Architecture Overview

The trending score system spans four files that work together:

| File | Role |
|------|------|
| `src/configs/constants.ts` | All tunable weights, time windows, and thresholds (`TRENDING_SCORE_CONFIG`) |
| `src/tokens/tokens.service.ts` | Core algorithm — `calculateTokenTrendingMetrics()` computes the score, `updateTokenTrendingScore()` persists it |
| `src/tokens/services/update-trending-tokens.service.ts` | Cron scheduler — runs every 10 minutes, selects which tokens to recalculate |
| `src/tokens/entities/token.entity.ts` | Database schema — `trending_score` (decimal 10,6) and `trending_score_update_at` columns |

Supporting files (read-only context):
- `src/tokens/tokens.controller.ts` — exposes `trending_score` as a sortable field in the token list API
- `src/tokens/dto/token.dto.ts` — DTO that surfaces `trending_score` and `trending_score_update_at` to clients

### How the Current Algorithm Works (Deep Dive)

1. **Data collection** — Four parallel DB queries fetch:
   - Unique wallet addresses that transacted with this specific token in the last 24h
   - Global min/max transaction counts per token (across all tokens active in 24h) for normalization
   - Global min/max AE volume per token for normalization
   - This token's total AE buy volume in 24h (only `buy` and `create_community` tx types)

2. **Normalization** — Min-Max scaling maps each token's raw value into `[0, 1]` relative to all other active tokens:
   ```
   tx_norm = (this_token_tx - min_across_all) / (max_across_all - min_across_all)
   vol_norm = (this_token_vol - min_across_all) / (max_across_all - min_across_all)
   ```

3. **Time decay** — Volume is divided by `lifetimeMinutes` (capped at 1440) so newer tokens with fast volume get a boost.

4. **Weighted sum** —
   ```
   score = 0.6 * tx_norm + 0.4 * (vol_norm / lifetimeMinutes)
   ```

5. **Floor** — Negative scores are clamped to 0.

6. **Persistence** — The score is written to the `token` table along with a timestamp.

### Quick Tweaks (Config Only — No Code Changes)

All of these live in `src/configs/constants.ts` under `TRENDING_SCORE_CONFIG`.

#### 1. Change the weight balance between activity and volume

```typescript
// File: src/configs/constants.ts
TRANSACTION_WEIGHT: 0.6,  // increase to favor tokens with many unique buyers
VOLUME_WEIGHT: 0.4,       // increase to favor tokens with large AE inflows
```

**Real-world example — "Whales matter more":**
If the platform wants to rank tokens where large investors are pouring money higher than tokens with many small buyers:
```typescript
TRANSACTION_WEIGHT: 0.3,
VOLUME_WEIGHT: 0.7,
```
This makes a token with 10 buyers putting in 10,000 AE rank higher than a token with 200 buyers putting in 500 AE.

**Real-world example — "Community engagement first":**
If the goal is to surface tokens with broad community interest regardless of invested capital:
```typescript
TRANSACTION_WEIGHT: 0.8,
VOLUME_WEIGHT: 0.2,
```

#### 2. Change the time window

```typescript
TIME_WINDOW_HOURS: 24,       // shrink to 6 for a "hot right now" feel
MAX_LIFETIME_MINUTES: 1440,  // should match TIME_WINDOW_HOURS * 60
```

**Real-world example — "What's hot in the last 6 hours":**
```typescript
TIME_WINDOW_HOURS: 6,
MAX_LIFETIME_MINUTES: 360,
```
Tokens that were popular yesterday but quiet today will drop off much faster.

#### 3. Enable/disable the cron job

```typescript
// File: src/configs/constants.ts
export const UPDATE_TRENDING_TOKENS_ENABLED = false; // set to true to activate
```

### Medium Tweaks (Algorithm Changes in tokens.service.ts)

#### 4. Add time decay (gravity) to penalize stale activity

Currently the algorithm doesn't decay scores over time within the window — a burst at hour 1 counts the same as a burst at hour 23. To add Hacker-News-style gravity:

**File:** `src/tokens/tokens.service.ts` — inside `calculateTokenTrendingMetrics()`

```typescript
// After calculating final_trending_score_result, add:
const hoursAge = lifetimeMinutes / 60;
const GRAVITY = 1.5; // higher = faster decay
final_trending_score_result = final_trending_score_result / Math.pow(hoursAge + 1, GRAVITY);
```

**Real-world example:** A token created 1 hour ago with score 0.8 would keep ~0.8. The same score on a 12-hour-old token becomes `0.8 / (13^1.5) ≈ 0.017`. This heavily rewards freshness.

You could also make `GRAVITY` a config constant:
```typescript
// In TRENDING_SCORE_CONFIG:
GRAVITY: 1.5,
```

#### 5. Add a holder count bonus

Reward tokens that have accumulated many unique holders (not just recent buyers):

**File:** `src/tokens/tokens.service.ts` — after computing the weighted sum

```typescript
const holderBonus = Math.log10(Math.max(token.holders_count, 1) + 1) / Math.log10(1001); // 0..1
const HOLDER_WEIGHT = 0.15;

// Redistribute weights: tx=0.5, vol=0.35, holders=0.15
final_trending_score_result =
  0.5 * tx_normalization_result +
  0.35 * (volume_normalization_result / lifetimeMinutes) +
  HOLDER_WEIGHT * holderBonus;
```

**Real-world example:** A meme token with 3 holders and huge volume from one whale would score lower than a token with 500 holders and moderate volume, surfacing more "legitimate" community tokens.

#### 6. Filter out wash trading by requiring minimum unique addresses

Add a threshold in the cron service so tokens with suspiciously few unique addresses but huge volume are excluded:

**File:** `src/tokens/services/update-trending-tokens.service.ts`

```typescript
// After fetching tokens, before the for-loop:
const MIN_UNIQUE_BUYERS = 3;
const eligibleTokens = tokens.filter(t => t.holders_count >= MIN_UNIQUE_BUYERS);

for (const token of eligibleTokens) {
  // ...existing logic
}
```

### Structural Tweaks (Schema + Cron Changes)

#### 7. Change the cron frequency

**File:** `src/tokens/services/update-trending-tokens.service.ts`

```typescript
@Cron(CronExpression.EVERY_10_MINUTES) // Change to EVERY_5_MINUTES or EVERY_MINUTE
```

Trade-off: more frequent = fresher rankings but higher DB load. For a platform with <10k tokens, every 5 minutes is fine.

#### 8. Add a new column for a secondary score

If you want to track multiple trending windows (e.g., 1h trending vs 24h trending):

**File:** `src/tokens/entities/token.entity.ts` — add a new column:

```typescript
@Column({
  type: 'decimal',
  precision: 10,
  scale: 6,
  default: 0,
})
trending_score_1h: number;
```

Then duplicate the calculation logic in `tokens.service.ts` with a shorter `TIME_WINDOW_HOURS` and store it in the new column.

#### 9. Switch normalization strategy from Min-Max to Z-Score

Min-Max is sensitive to outliers — one token with 100x the volume of all others compresses everyone else near 0. Z-Score normalization is more resilient:

**File:** `src/tokens/tokens.service.ts` — replace the normalization queries

Instead of querying min/max, query mean and standard deviation:
```sql
SELECT AVG(volume) as mean_volume, STDDEV(volume) as std_volume ...
```
Then normalize as:
```typescript
const vol_zscore = (investmentVolume - meanVolume) / stdVolume;
```

**Real-world example:** If one whale token has 500,000 AE volume and all others have 100-5,000 AE, Min-Max gives every non-whale token a score near 0. Z-Score would give the whale a high positive z-score (~3+) while still spreading regular tokens across a meaningful range.

### Testing Changes

1. The `calculateTokenTrendingMetrics()` method returns a detailed breakdown object with formulas and intermediate results — use the API endpoint that exposes it to verify scores before and after your changes.
2. The `UPDATE_TRENDING_TOKENS_ENABLED` flag lets you disable the cron while testing manually.
3. Check for `NaN` edge cases — the existing `fixAllNanTrendingTokens()` method in the cron service patches bad data, but new formula changes could introduce new division-by-zero paths (e.g., if stddev is 0 for z-score).

### Summary: What to Change and Where

| Goal | File(s) to Change |
|------|--------------------|
| Adjust weight balance | `src/configs/constants.ts` — `TRANSACTION_WEIGHT`, `VOLUME_WEIGHT` |
| Change time window | `src/configs/constants.ts` — `TIME_WINDOW_HOURS`, `MAX_LIFETIME_MINUTES` |
| Add time decay / gravity | `src/tokens/tokens.service.ts` — `calculateTokenTrendingMetrics()` |
| Add new signals (holders, market cap) | `src/tokens/tokens.service.ts` — add queries + weighted terms |
| Filter spam/wash trades | `src/tokens/services/update-trending-tokens.service.ts` — pre-filter tokens |
| Change update frequency | `src/tokens/services/update-trending-tokens.service.ts` — `@Cron()` decorator |
| Add new score columns | `src/tokens/entities/token.entity.ts` + migration |
| Change normalization method | `src/tokens/tokens.service.ts` — replace min/max queries with mean/stddev |
| Expose new sort options | `src/tokens/tokens.controller.ts` — `allowedSortFields` array |
| Enable/disable trending cron | `src/configs/constants.ts` — `UPDATE_TRENDING_TOKENS_ENABLED` |
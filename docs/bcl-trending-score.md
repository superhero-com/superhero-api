## Token trending score

The token trending score is designed to reward active communities, not just capital inflow.

The score now prioritizes:

- buying and selling activity,
- direct social activity around the token,
- follow-up engagement on token-related posts,
- recency of the latest meaningful activity.

This means a token can trend because its community is actively posting, discussing, buying, and selling, even in lower-volume environments.

## Why the algorithm changed

The previous formula relied on global min-max normalization and a volume-over-lifetime term. That had a few problems:

- it behaved poorly when overall platform activity was low,
- it could produce `NaN` when min and max collapsed,
- it rewarded volume more than community usage,
- it did not incorporate post activity at all.

The new version uses capped logarithmic normalization plus recency decay. It is more stable in both sparse and high-traffic conditions.

## High-level formula

The implementation calculates two group scores:

- `trading_score`
- `social_score`

Then combines them and applies freshness decay:

```text
pre_decay_score =
  group_weight_trading * trading_score +
  group_weight_social * social_score

trending_score =
  pre_decay_score * freshness_decay
```

Freshness decay is based on the latest activity seen for the token:

```text
freshness_decay = 1 / (1 + age_hours / bias_hours) ^ gravity
```

So the same amount of engagement scores lower if it is old, and recent activity is rewarded heavily.

## Normalization

Each raw signal is normalized independently with a cap:

```text
normalized_signal = log(1 + min(raw, cap)) / log(1 + cap)
```

Why this is better than min-max for trending:

- it never divides by zero,
- it does not depend on the rest of the token universe at query time,
- it handles low activity and high activity consistently,
- it gives diminishing returns so one whale or one viral spike does not completely dominate.

## Signals used

### Trading signals

Trading still matters, but it is secondary to community usage.

- `active_wallets`: distinct wallets that traded the token in the window
- `buy_count`: number of buy transactions
- `sell_count`: number of sell transactions
- `volume_ae`: total AE volume across `buy`, `sell`, and `create_community`

### Social signals

Social activity is driven by direct token mentions, then expanded to surrounding engagement.

- `mention_posts`: top-level posts that directly mention the token using `#TOKEN`
- `mention_comments`: comments in token-related discussions
- `unique_authors`: distinct authors participating in those token-related posts/comments
- `tips_count`: number of tips on token-related posts/comments
- `tips_amount_ae`: total AE tipped on token-related posts/comments
- `reads`: read counts from `post_reads_daily` for token-related posts/comments

## How social attribution works

The system persists normalized token mentions on every post as `token_mentions`.

Attribution rules:

1. A direct `#TOKEN` mention attaches a post to that token symbol.
2. Top-level posts with a direct mention become the root of a token discussion thread.
3. Comments on those posts count as token community activity even if the comment does not repeat the hashtag.
4. Tips and reads on those posts/comments also count.

This lets trending reflect actual usage of the platform around a token instead of only on-chain trades.

## Current configuration

All trending tuning lives in `src/configs/constants.ts` under `TRENDING_SCORE_CONFIG`.

### Window and refresh

```ts
WINDOW_HOURS: 24,
REFRESH_CRON: '*/2 * * * *',
ACTIVITY_LOOKBACK_MINUTES: 15,
MAX_ACTIVE_BATCH: 250,
MAX_STALE_BATCH: 150,
MAX_CONCURRENT_UPDATES: 8,
STALE_AFTER_MINUTES: 30,
```

### Group weights

```ts
GROUP_WEIGHTS: {
  trading: 0.35,
  social: 0.65,
}
```

Social activity dominates by design.

### Trading weights

```ts
TRADING_WEIGHTS: {
  activeWallets: 0.4,
  buyCount: 0.2,
  sellCount: 0.2,
  volumeAe: 0.2,
}
```

### Social weights

```ts
SOCIAL_WEIGHTS: {
  mentionPosts: 0.32,
  mentionComments: 0.32,
  uniqueAuthors: 0.22,
  tipsCount: 0.05,
  tipsAmountAe: 0.03,
  reads: 0.06,
}
```

### Caps

```ts
CAPS: {
  activeWallets: 25,
  buyCount: 40,
  sellCount: 40,
  volumeAe: 5000,
  mentionPosts: 15,
  mentionComments: 50,
  uniqueAuthors: 20,
  tipsCount: 15,
  tipsAmountAe: 250,
  reads: 200,
}
```

These caps define where a signal is considered "strong enough" for normalization purposes. More activity still helps freshness, but no single metric can scale linearly forever.

### Decay

```ts
DECAY: {
  biasHours: 2,
  gravity: 1.15,
}
```

Higher `gravity` makes stale tokens fall faster. Higher `biasHours` makes the decay gentler.

## Refresh paths

The score refreshes through several paths:

### Live transaction updates

When a token trade is processed live, the score is recalculated immediately.

Relevant files:

- `src/transactions/services/transaction.service.ts`
- `src/plugins/bcl/services/transaction-processor.service.ts`

### Live social updates

When a post, comment, or post tip is processed, affected token symbols are recalculated immediately.

Relevant files:

- `src/social/services/post.service.ts`
- `src/plugins/social/services/post-transaction-processor.service.ts`
- `src/tipping/services/tips.service.ts`
- `src/plugins/social-tipping/services/social-tipping-transaction-processor.service.ts`

### Fast cron refresh

Every 2 minutes, the scheduler refreshes tokens affected by:

- recent trades,
- recent token-related posts/comments,
- recent tips,
- recent reads.

It also backfills stale rows separately so decay continues even when no new event fires.

Relevant file:

- `src/tokens/services/update-trending-tokens.service.ts`

## Sorting behavior

The token list API exposes `trending_score` as a sortable field.

When sorting by `trending_score`, zero-score tokens fall back to newest-created first. This prevents a long tail of inactive tokens from looking random.

Relevant files:

- `src/tokens/tokens.controller.ts`
- `src/tokens/tokens.service.ts`

## Debugging and validation

Use `GET /tokens/:address/score` to force a recalculation and inspect the returned metric breakdown.

The breakdown includes:

- all raw signal values,
- each normalized metric,
- trading/social component scores,
- latest activity timestamps,
- final decay multiplier,
- final stored score.

## Files involved

| File | Purpose |
|------|---------|
| `src/configs/constants.ts` | Tunable config for weights, caps, windows, and decay |
| `src/tokens/tokens.service.ts` | Main scoring algorithm and persistence |
| `src/tokens/services/update-trending-tokens.service.ts` | Fast cron refresh plus stale-row backfill |
| `src/tokens/entities/token.entity.ts` | Persisted `trending_score` and `trending_score_update_at` |
| `src/social/entities/post.entity.ts` | Persisted `token_mentions` used for attribution |
| `src/social/utils/content-parser.util.ts` | Extracts normalized `#TOKEN` mentions |
| `src/social/services/post.service.ts` | Social save path, triggers recalculation |
| `src/plugins/social/services/post-transaction-processor.service.ts` | Plugin social save path, triggers recalculation |
| `src/tipping/services/tips.service.ts` | Direct tip save path, triggers recalculation |
| `src/plugins/social-tipping/services/social-tipping-transaction-processor.service.ts` | Plugin tip save path, triggers recalculation |
| `src/tokens/tokens.controller.ts` | Exposes score endpoint and sorting |

## Design notes

### Why posts matter more now

The product goal is to encourage users to use the platform more often. A token should trend because its community is active across the platform, not only because a few wallets bought it.

That is why:

- social signals have higher total weight than trading signals,
- comments on token-related posts count,
- tips are only weak supporting signals, and reads remain lower weight than posting and discussion,
- recency matters so active communities stay visible.

### Why reads are low-weight

Reads are currently recorded only on post detail views, not every feed impression. They are useful as a supporting signal, but not reliable enough to dominate ranking.

### Why direct mentions are the attribution source

There is no dedicated persisted `post -> token` foreign key in the data model. Using direct normalized `#TOKEN` mentions is the most reliable attribution mechanism available today.

## Inspiration from other ranking systems

The current design borrows proven ideas from broader ranking systems:

- crypto discovery products commonly blend market activity, credibility, and community engagement,
- social feeds reward meaningful interactions over raw totals,
- Hacker News and similar systems use gravity-style decay to keep rankings fresh,
- Reddit-style ranking uses logarithmic scaling so large numbers have diminishing returns.

This implementation applies those same principles to token discovery inside the platform.
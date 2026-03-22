## Popular post ranking

The popular post endpoint ranks content by a weighted engagement score, then applies time decay so newer activity stays visible.

The current implementation rewards posts that attract:

- comments,
- tips,
- unique tippers,
- reads,
- association with currently trending topics,
- better-quality content,
- stronger author reputation signals.

It does not simply sort by raw comment count or raw tip amount.

## Endpoint and windows

The ranking powers `GET /posts/popular`.

Supported windows:

- `24h`
- `7d`
- `all`

The same scoring model is used for all windows, but the time decay and candidate pool differ per window.

## Which posts are even eligible

A regular post is considered for ranking only if it is:

- not hidden,
- a top-level post (`post_id IS NULL`),
- inside the requested time window for `24h` and `7d`.

Comments are not ranked directly as standalone popular items. Their impact is counted through the parent post's `total_comments`.

For the `all` window, the system does not filter by age, but it still only evaluates the newest candidate set up to the configured cap.

## Candidate caps

Before scoring, the service limits how many recent items it evaluates:

```ts
MAX_CANDIDATES_24H: 500,
MAX_CANDIDATES_7D: 3000,
MAX_CANDIDATES_ALL: 10000,
```

This means popularity is computed only within the newest candidate pool for that window, not across every post ever created.

## High-level formula

Each candidate gets a weighted numerator from engagement and author signals:

```text
numerator =
  w_comments * log(1 + comments) +
  w_tips_amount * log(1 + tipsAmountAE) +
  w_tips_count * log(1 + tipsCount) +
  w_interactions_per_hour * log(1 + interactionsPerHour) +
  w_reads * log(1 + readsPerHour) +
  w_trending * trendingBoost +
  w_quality * contentQuality +
  w_balance * accountBalanceFactor +
  w_account_age * accountAgeFactor +
  w_invites * invitesFactor +
  w_owned_trends * ownedTrendsFactor
```

Then the score is decayed by age:

```text
score = numerator / (ageHours + t_bias) ^ gravity
```

Where:

- `ageHours` is the post age in hours,
- `t_bias` prevents very new posts from exploding,
- `gravity` controls how fast older posts fall.

## Current weights

All weights live in `src/configs/constants.ts` under `POPULAR_RANKING_CONFIG`.

```ts
WEIGHTS: {
  comments: 1.7,
  tipsAmountAE: 4.0,
  tipsCount: 1,
  interactionsPerHour: 0.2,
  trendingBoost: 0.4,
  contentQuality: 0.3,
  accountBalance: 0.2,
  accountAge: 0.02,
  invites: 2,
  ownedTrends: 1.5,
  reads: 1.0,
}
```

### What matters most

The biggest direct drivers are:

- `tipsAmountAE`
- `invites`
- `comments`
- `ownedTrends`
- `reads`

Because logarithms are used for the count- and amount-based signals, all of them have diminishing returns. Doubling activity helps, but not linearly forever.

## Ranking signals

### 1. Comments

The score uses `post.total_comments`.

More discussion helps a post trend, but through `log(1 + comments)`, so going from 0 to 5 comments matters more than going from 500 to 505.

### 2. Tip amount

The total AE tipped on the post is summed and scored with:

```text
log(1 + tipsAmountAE)
```

This is currently the strongest direct engagement signal in the formula.

### 3. Tip count

The number of tips also contributes separately from total value. This helps distinguish one large tip from repeated support by multiple users.

### 4. Interactions per hour

The service calculates:

```text
interactionsPerHour = (comments + uniqueTippers) / ageHours
```

This rewards momentum. A post getting discussion and support quickly performs better than a post that accumulated the same totals much more slowly.

### 5. Reads

Reads are pulled from `post_reads_daily` and summed across the selected window.

The ranking uses:

```text
readsPerHour = reads / ageHours
```

Then applies:

```text
log(1 + readsPerHour)
```

So reads do matter, but they are normalized by age and weighted more modestly than tip amount.

### 6. Trending topic boost

If a post has topics, the system looks up the highest trending-tag score among them and normalizes it:

```text
trendingBoost = min(1, maxTrendingTagScore / 100)
```

A post with at least one strongly trending topic gets a modest boost. The algorithm uses the single strongest topic score, not the sum of all topic scores.

### 7. Content quality

The content-quality factor is a heuristic in the range `[0..1]`.

It rewards:

- enough text length,
- a healthy alphanumeric ratio,
- lower emoji saturation.

It penalizes very short, emoji-heavy posts especially hard.

In practice, this helps reduce spammy low-effort content from dominating on pure engagement tricks alone.

### 8. Author account balance

The author's AE balance is fetched and normalized against:

```ts
BALANCE_NORMALIZER_AE: 500_000
```

This becomes a small reputation-style factor in the range `[0..1]`.

### 9. Author account age

Older accounts receive a tiny boost via a sigmoid-style curve centered roughly around the first two weeks of account age.

This is intentionally a very small factor.

### 10. Invitations sent

The algorithm counts invitations sent by the author and normalizes them logarithmically up to 100 invites:

```text
invitesFactor = log(1 + sentInvites) / log(1 + 100)
```

This acts as a reputation/community-building signal.

### 11. Owned token portfolio value

The service calculates the author's token holdings value and normalizes it into `[0..1]`.

By default the normalization is based on AE value:

```ts
OWNED_TRENDS_VALUE_CURRENCY: 'ae'
OWNED_TRENDS_VALUE_NORMALIZER_AE: 20000
```

So an account with roughly `20,000 AE` worth of tracked token holdings approaches the maximum contribution from this factor.

## Time decay by window

The time-decay settings are:

```ts
GRAVITY: 1.6,
GRAVITY_7D: 0.5,
T_BIAS: 1.0,
```

How that behaves:

- `24h` uses `gravity = 1.6`, so recency matters a lot.
- `7d` uses `gravity = 0.5`, so good posts stay competitive longer.
- `all` uses `gravity = 0.0`, so there is no age decay after a post enters the candidate pool.

This means the `24h` feed is momentum-heavy, while the `all` feed behaves more like an all-time best-of list within the capped candidate set.

## Score floors

After scoring, low-signal items are filtered out entirely:

```ts
SCORE_FLOOR_DEFAULT: 0.01,
SCORE_FLOOR_7D: 0.008,
SCORE_FLOOR_ALL: 0.1,
```

If a post does not reach the floor for the selected window, it will not appear in the cached popular ranking at all.

## Governance polls and plugin content

The popular feed can also include plugin-provided content items, not only regular posts.

Today, governance polls participate through the plugin ranking interface.

For polls:

- `votes_count` is used as the `comments`-equivalent engagement signal,
- tips are currently treated as `0`,
- reads are currently treated as `0`,
- the same content-quality, author, and decay logic still applies.

This is why the endpoint can return mixed item types while still ranking them with a comparable scoring model.

## Caching behavior

Computed rankings are stored in Redis sorted sets for:

- `popular:24h`
- `popular:7d`
- `popular:all`

TTL is currently:

```ts
REDIS_TTL_SECONDS: 30
```

So the feed is intentionally refreshed often.

## Practical interpretation

A post is most likely to rank highly when it is:

- recent,
- top-level,
- receiving comments quickly,
- receiving meaningful AE tips,
- getting support from multiple unique tippers,
- being read actively,
- connected to a trending topic,
- written with enough substance to avoid quality penalties,
- authored by an account with stronger reputation-style signals.

## Files involved

| File | Purpose |
|------|---------|
| `src/social/services/popular-ranking.service.ts` | Main candidate selection, scoring, decay, and Redis caching |
| `src/configs/constants.ts` | Ranking weights, decay, score floors, and candidate caps |
| `src/social/controllers/posts.controller.ts` | Exposes `GET /posts/popular` |
| `src/plugins/popular-ranking.interface.ts` | Plugin contract for non-post content |
| `src/plugins/governance/services/governance-popular-ranking.service.ts` | Governance poll contribution to popular ranking |

## Design notes

### Why logs are used

Most numeric signals use `log(1 + x)` so the ranking favors meaningful activity without letting one giant raw number dominate forever.

### Why recency still wins in 24h

The `24h` window is intended to surface active conversations now, not just the largest totals accumulated earlier in the day.

### Why reputation signals exist

Account balance, account age, invites, and owned token value are all relatively small compared to direct engagement, but they help the feed lean toward established, credible participants when engagement is otherwise close.

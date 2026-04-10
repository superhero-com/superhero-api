## Popular post ranking

The popular post endpoint ranks content by accumulated engagement — a "Top" style ranking with no time decay. The time window itself acts as the freshness filter.

The current implementation rewards posts that attract:

- comments,
- tips,
- unique tippers,
- reads,
- association with currently trending topics,
- better-quality content.

It does not simply sort by raw comment count or raw tip amount.

## Endpoint and windows

The ranking powers `GET /posts/popular`.

Supported windows:

- `24h` (default)
- `7d`
- `all`

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

## Formula

Each candidate gets a score from accumulated engagement and content signals:

```text
score =
  w_comments * log(1 + comments) +
  w_tips_amount * log(1 + tipsAmountAE) +
  w_tips_count * log(1 + tipsCount) +
  w_reads * log(1 + reads) +
  w_trending * trendingBoost +
  w_quality * contentQuality
```

There is no time-decay divisor. The score is purely based on engagement within the selected window.

## Current weights

All weights live in `src/configs/constants.ts` under `POPULAR_RANKING_CONFIG`.

```ts
WEIGHTS: {
  comments: 2.5,
  tipsAmountAE: 2.0,
  tipsCount: 1.0,
  trendingBoost: 0.5,
  contentQuality: 0.3,
  reads: 1.5,
}
```

### What matters most

The biggest direct drivers are:

- `comments`
- `tipsAmountAE`
- `reads`

Because logarithms are used for all count- and amount-based signals, they have diminishing returns. Doubling activity helps, but not linearly forever.

### Why tips are not the dominant signal

Tipping is a rare action on this network. The weight for `tipsAmountAE` (2.0) is deliberately lower than `comments` (2.5) so that a single generous tip cannot vault a post above all others. Comments and reads — being the most common engagement signals — lead the ranking.

## Ranking signals

### 1. Comments

The score counts comments (replies) on the post, excluding the post author's own replies. This prevents authors from inflating their ranking by replying to their own posts.

More discussion helps a post rank higher, but through `log(1 + comments)`, so going from 0 to 5 comments matters more than going from 500 to 505.

### 2. Tip amount

The total AE tipped on the post (excluding self-tips) is summed and scored with:

```text
log(1 + tipsAmountAE)
```

### 3. Tip count

The number of tips also contributes separately from total value. This helps distinguish one large tip from repeated support by multiple users.

### 4. Reads

Reads are pulled from `post_reads_daily` and summed across the selected window.

The ranking uses raw reads:

```text
log(1 + reads)
```

Reads are not normalized by age — the window boundary handles freshness.

### 5. Trending topic boost

If a post has topics, the system looks up the highest trending-tag score among them and normalizes it:

```text
trendingBoost = min(1, maxTrendingTagScore / 100)
```

A post with at least one strongly trending topic gets a modest boost. The algorithm uses the single strongest topic score, not the sum of all topic scores.

### 6. Content quality

The content-quality factor is a heuristic in the range `[0..1]`.

It rewards:

- enough text length,
- a healthy alphanumeric ratio,
- lower emoji saturation.

It penalizes very short, emoji-heavy posts especially hard.

In practice, this helps reduce spammy low-effort content from dominating on pure engagement tricks alone.

## Governance polls and plugin content

The popular feed can also include plugin-provided content items, not only regular posts.

Today, governance polls participate through the plugin ranking interface.

For polls:

- `votes_count` is used as the `comments`-equivalent engagement signal,
- tips are currently treated as `0`,
- reads are currently treated as `0`,
- the same content-quality logic still applies.

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

When the cache is empty (cold start or after TTL expiry with no cron), recompute is triggered in the background with a per-window mutex to prevent stampede. The current request falls back to recent posts while the cache is being rebuilt.

## Practical interpretation

A post is most likely to rank highly when it is:

- top-level,
- receiving many comments,
- receiving meaningful AE tips from multiple tippers,
- being read actively,
- connected to a trending topic,
- written with enough substance to avoid quality penalties.

## Files involved

| File | Purpose |
|------|---------|
| `src/social/services/popular-ranking.service.ts` | Main candidate selection, scoring, and Redis caching |
| `src/configs/constants.ts` | Ranking weights and candidate caps |
| `src/social/controllers/posts.controller.ts` | Exposes `GET /posts/popular` |
| `src/plugins/popular-ranking.interface.ts` | Plugin contract for non-post content |
| `src/plugins/governance/services/governance-popular-ranking.service.ts` | Governance poll contribution to popular ranking |

## Design notes

### Why logs are used

Most numeric signals use `log(1 + x)` so the ranking favors meaningful activity without letting one giant raw number dominate forever.

### Why there is no time decay

This is a "Top" ranking, not a "Hot" ranking. The time window itself (24h, 7d, all) acts as the freshness filter. Within a window, posts compete purely on accumulated engagement. This is simpler, more transparent, and better suited for a low-activity network where posts need time to gather signals.

### Why there are no score floors

All posts within the candidate pool are included. On a low-activity network, filtering out low-signal posts would leave the feed empty. Zero-engagement posts simply sort to the bottom by their small content-quality score.

### Why user wallet and reputation signals are excluded

Popular ranking intentionally does not use author account balance, account age, invite counts, or owned-token portfolio value. The feed is driven by engagement on the content itself plus topic momentum and lightweight quality heuristics, so visibility does not depend on wealth or account metadata.

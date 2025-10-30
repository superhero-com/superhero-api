# Definitions

* Let token = **T**.
* Pools where **T** appears: (P = {p_1,\dots,p_n}).
* For pool (p), reserves ((r_T^{(p)}, r_{X}^{(p)})) with the counter-asset (X).
* Use a **pricing function** (price(asset \rightarrow AE)) (or USD) derived from either:

  * the deepest AE pairs, or
  * a routing oracle (T→AE, X→AE), with a **liquidity-weighted median/TWAP** across pools to reduce manipulation.

---

# TVL (for the *token T* page)

You usually want the **value of T’s reserves across all pools**, *not* the whole pool TVL (which would double-count the other assets when you add per-token TVLs).

$$
\text{TokenTVL}*T = \sum*{p \in P} \big( r_T^{(p)} \times price(T \rightarrow AE) \big)
$$

Optionally also show “Pool TVL where T appears”:
$$
\text{PoolsTVL}*T = \sum*{p \in P} \big( r_T^{(p)} \times price(T \rightarrow AE) + r_X^{(p)} \times price(X \rightarrow AE) \big)
$$
…but for a token info page, **TokenTVL_T** is the standard, avoids double-counting, and reflects *how much T liquidity* exists on the DEX.

---

# 24h Volume (for T)

Sum **all swaps involving T** across all pools over the last 24h, valued in a common unit (AE or USD). Value each trade at execution price if you have it; otherwise approximate with per-trade pool mid-price at the time (or current price if you must).

$$
\text{Vol}*{24h}(T) = \sum*{\text{trades } i \text{ in last 24h where } T \text{ is in/out}} \big( \text{amount}_i^{T} \times price(T \rightarrow AE \text{ at } t_i) \big)
$$

If you only have per-pool 24h volume in quote units, convert and sum:
$$
\text{Vol}*{24h}(T) = \sum*{p \in P} \big( \text{Vol}_{24h}^{(p)}(\text{in } T\text{-terms}) \times price(T \rightarrow AE) \big)
$$

---

# Total (All-Time) Volume (for T)

Same as 24h but over all historical trades (or maintain a rolling counter), aggregated across all pools containing T:
$$
\text{Vol}*{\text{all}}(T) = \sum*{p \in P} \text{Vol}_{\text{all}}^{(p)}(\text{in } T\text{-terms}) \times price(T \rightarrow AE)
$$

---

# 24h Change

Two common “change” metrics:

**1) Price change (preferred on token pages):**
Compute a robust price for T using a **liquidity-weighted TWAP** over the main pools, then compare now vs 24h ago.

* Per-pool TWAP price (TWAP_p(T\rightarrow AE)).
* Aggregate with liquidity weights (w_p) (e.g., based on active liquidity or pool TVL in AE):
$$
  Price_{\text{now}} = \frac{\sum_p w_p \cdot TWAP_{p,\text{now}}}{\sum_p w_p},\quad
  Price_{24h} = \frac{\sum_p w_p \cdot TWAP_{p,24h}}{\sum_p w_p}
$$
$$
  Delta_{24h} = \frac{Price_{\text{now}} - Price_{24h}}{Price_{24h}} \times 100%
$$

**2) Volume change:**
$$
Delta \text{Vol}*{24h} = \frac{\text{Vol}*{last,24h}(T) - \text{Vol}*{prev,24h}(T)}{\text{Vol}*{prev,24h}(T)} \times 100%
$$

---

# Why not AE-only?

* **Coverage:** T might have deep liquidity vs stablecoins or bridged assets; AE-only ignores that liquidity/flow.
* **Bias:** Price and volume can be distorted if the AE pool isn’t the deepest.
* **Arb/Fragmentation:** Real trading might route across non-AE pools; AE-only underreports.

Use AE (or USD) **only as a reporting denomination**, but **aggregate across *every* pool where T appears**.

---

# Implementation Tips (practical)

* **Pricing:** pick a conservative source:

  * liquidity-weighted median across top N pools (by active liquidity) to resist outliers, or
  * route via deepest path T→AE using current pool mid-price or TWAP.
* **Concentrated Liquidity (v3-style):** weight by *active in-range liquidity* at current price, not full TVL.
* **Double counting:** don’t sum full pool TVLs for a “token TVL”; sum *T reserves × T price* instead.
* **Caching:** pre-aggregate per-pool 1m/5m buckets → roll up to 24h/all-time for speed.
* **Stables display:** optionally show a breakdown by counter-asset (AE, USDT, wETH, …) for transparency.

---

## TL;DR

* **TVL (token):** sum T’s reserves across **all pools**, valued in AE (or USD).
* **24h Volume:** sum trades involving T across **all pools**, valued consistently.
* **Total Volume:** same as above, all-time.
* **24h Change:** compute a cross-pool, liquidity-weighted **price** change (and optionally volume change).
  → **Do not** use only the T/AE pair for these aggregates; use it mainly for denomination/pricing.

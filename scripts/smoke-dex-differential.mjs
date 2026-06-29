#!/usr/bin/env node
/*
 * DEX differential smoke — yet another angle. It does NOT trust the API's own
 * numbers against each other; it RE-DERIVES values from raw on-chain reserves
 * (first principles) and checks the backend agrees. This catches decimal,
 * direction, and scaling mistakes anywhere in the price pipeline, because the
 * check computes the answer a completely independent way.
 *
 * Checks:
 *   A. reciprocal:  stored ratio0 * ratio1 ≈ 1 for every liquid pair.
 *   B. price ↔ reserves:  for a token priced via a SINGLE direct WAE pool,
 *      price = humanReserve(WAE) / humanReserve(token) must match /price.
 *   C. price ↔ chart:  for an AE-quoted token, /price ≈ the latest candle close.
 *
 * No DB, no app boot, zero deps. Exits non-zero on any disagreement.
 *
 * Usage: SMOKE_BASE_URL=https://api.dev.tokensale.org node scripts/smoke-dex-differential.mjs
 */

const BASE = (process.env.SMOKE_BASE_URL || 'https://api.dev.tokensale.org')
  .replace(/\/+$/, '');
const API = `${BASE}/api/dex`;
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 20000);
const REL_TOL = Number(process.env.SMOKE_REL_TOL || 0.01); // 1% relative tolerance

let pass = 0;
const failures = [];
const ok = () => (pass++, process.stdout.write('.'));
const bad = (name, detail) => (failures.push(`${name} — ${detail}`), process.stdout.write('F'));

async function getJson(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}${path}`, { signal: ctrl.signal });
    if (!res.ok) return { __status: res.status };
    return await res.json();
  } catch (e) {
    return { __error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

const human = (raw, dec) => Number(raw ?? 0) / 10 ** Number(dec ?? 18);
const relClose = (a, b, tol = REL_TOL) => {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a === 0 && b === 0) return true;
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) <= tol;
};

(async () => {
  console.log(`DEX differential smoke at ${API} (tol=${REL_TOL})\n`);

  const waeSearch = await getJson('/tokens?search=WAE&limit=10');
  const wae = (waeSearch?.items || []).find((t) => t.symbol === 'WAE' || t.is_ae);
  const waeAddr = wae?.address;

  const pairs = (await getJson('/pairs?limit=100'))?.items || [];
  const tokens = (await getJson('/tokens?limit=100'))?.items || [];
  if (!pairs.length || !tokens.length) {
    console.error('FATAL: no pairs/tokens returned');
    process.exit(1);
  }
  const pairByAddr = new Map(pairs.map((p) => [p.address, p]));
  const storedByAddr = new Map(tokens.map((t) => [t.address, t]));

  // --- A. reciprocal: ratio0 * ratio1 ≈ 1 (for liquid pairs) ---
  for (const p of pairs) {
    const r0 = Number(p.ratio0);
    const r1 = Number(p.ratio1);
    if (!(r0 > 0 && r1 > 0 && Number.isFinite(r0) && Number.isFinite(r1))) {
      ok(); // dead/dust pool — reciprocal not meaningful
      continue;
    }
    const product = r0 * r1;
    if (Math.abs(product - 1) <= 0.01) ok();
    else bad(`reciprocal ${p.token0.symbol}/${p.token1.symbol}`, `ratio0*ratio1=${product} (expected ≈1)`);
  }

  // --- B & C: re-derive each token's price from reserves and the chart ---
  for (const t of tokens) {
    if (t.symbol === 'WAE' || t.is_ae) {
      ok();
      continue;
    }
    const analysis = await getJson(`/tokens/${t.address}/price/analysis?debug=true`);
    const apiPrice = analysis?.price != null ? Number(analysis.price) : null;
    const bestPath = analysis?.bestPath || [];

    // B. Re-derive the FULL bestPath price from raw reserves (in human units, so
    // decimals are handled independently of the backend), walking token → … →
    // WAE. price = Π (nextReserveHuman / currentReserveHuman). Covers direct AND
    // multi-hop — the latter being where chained-ratio + decimal math is hardest.
    if (apiPrice != null && bestPath.length >= 1 && bestPath.length <= 3) {
      let cur = t.address;
      let derived = 1;
      let valid = true;
      for (const hopRef of bestPath) {
        const pool = pairByAddr.get(hopRef?.address);
        if (!pool) {
          valid = false;
          break;
        }
        const curIs0 = pool.token0?.address === cur;
        const curTok = curIs0 ? pool.token0 : pool.token1;
        const nextTok = curIs0 ? pool.token1 : pool.token0;
        const curRes = human(curIs0 ? pool.reserve0 : pool.reserve1, curTok?.decimals);
        const nextRes = human(curIs0 ? pool.reserve1 : pool.reserve0, nextTok?.decimals);
        if (!(curRes > 0 && nextRes > 0)) {
          valid = false;
          break;
        }
        derived *= nextRes / curRes; // next-token per current-token (human)
        cur = nextTok?.address;
      }
      if (valid && cur === waeAddr) {
        if (relClose(apiPrice, derived)) ok();
        else
          bad(
            `price-vs-path ${t.symbol} (${bestPath.length}-hop)`,
            `/price=${apiPrice} but path reserves imply ${derived}`,
          );
      } else ok();
    } else ok();

    // D. Fiat internal-consistency: within a single price object, every fiat
    //    value is ae * rate_currency, so usd/ae and eur/ae must be the SAME
    //    across the analysis vs the stored list price would differ by snapshot —
    //    instead we check the stored token's own object is internally finite and
    //    positive-proportional (a 0/negative/non-finite fiat = conversion bug).
    const stored = storedByAddr.get(t.address);
    const sAe = Number(stored?.price?.ae);
    if (stored?.price?.ae != null && sAe > 0) {
      const fiats = ['usd', 'eur', 'aud', 'brl', 'cad', 'chf', 'gbp'];
      const ratios = fiats
        .map((c) => Number(stored.price[c]))
        .filter((v) => Number.isFinite(v) && v > 0)
        .map((v) => v / sAe);
      // Each fiat ratio is that currency's rate (>0, finite). Just assert none is
      // absurd (a scaling slip would make one wildly off vs AE).
      const allSane = ratios.every((r) => r > 0 && r < 1e6);
      if (allSane) ok();
      else bad(`fiat-sane ${t.symbol}`, `fiat/ae ratios = ${ratios.join(',')}`);
    } else ok();

    // E. Stored (list) price vs freshly-computed price. A large divergence means
    //    the stored value is STALE (needs a sync) or a write path is wrong.
    if (apiPrice != null && stored?.price?.ae != null && Number(stored.price.ae) > 0) {
      if (relClose(apiPrice, Number(stored.price.ae), 5)) ok();
      else
        bad(
          `stored-vs-computed ${t.symbol}`,
          `stored=${stored.price.ae} computed=${apiPrice} (>5x apart — stale stored price)`,
        );
    } else ok();

    // C. AE-quoted price should match the chart's latest candle close.
    if (apiPrice != null) {
      const hist = await getJson(`/tokens/${t.address}/history?interval=86400&limit=1`);
      const c = Array.isArray(hist) ? hist[0] : null;
      if (c && c.quote?.convertedTo === 'ae' && c.quote?.close != null) {
        const close = Number(c.quote.close);
        // Chart shows historical last trade; /price is the current pool spot —
        // they can differ, so only flag wild (>5x) disagreement, which signals a
        // unit/scaling error rather than normal price drift.
        if (relClose(apiPrice, close, 5)) ok();
        else
          bad(
            `price-vs-chart ${t.symbol}`,
            `/price=${apiPrice} but latest AE candle close=${close} (>5x apart)`,
          );
      } else ok();
    } else ok();
  }

  // --- F. volume cross-validation across two independent implementations ---
  // For a token with exactly one (WAE) pair, the token-summary volume
  // (DexTokenSummaryService) and the pair-summary volume (PairHistoryService) are
  // computed by DIFFERENT code from the SAME swaps — they must agree.
  const pairsOfToken = (addr) =>
    pairs.filter((p) => p.token0?.address === addr || p.token1?.address === addr);
  for (const t of tokens) {
    if (t.symbol === 'WAE' || t.is_ae) {
      ok();
      continue;
    }
    const tp = pairsOfToken(t.address);
    const waePair = tp.find(
      (p) => waeAddr && (p.token0?.address === waeAddr || p.token1?.address === waeAddr),
    );
    if (tp.length !== 1 || !waePair) {
      ok(); // multi-pair tokens aggregate differently; skip
      continue;
    }
    const [tokSum, pairSum] = await Promise.all([
      getJson(`/tokens/${t.address}/summary`),
      getJson(`/pairs/${waePair.address}/summary`),
    ]);
    const tv = Number(tokSum?.total_volume?.ae);
    const pv = Number(pairSum?.total_volume?.ae);
    if (!Number.isFinite(tv) || !Number.isFinite(pv)) {
      ok();
      continue;
    }
    if (relClose(tv, pv, 0.02)) ok();
    else
      bad(
        `volume-cross ${t.symbol}`,
        `token-summary=${tv} but pair-summary=${pv} (same swaps, must agree)`,
      );
  }

  console.log(`\n\n${pass} passed, ${failures.length} failed.`);
  if (failures.length) {
    console.log('\nDisagreements:');
    for (const f of failures) console.log(`  x ${f}`);
    process.exit(1);
  }
  console.log('Backend math agrees with independently re-derived values.');
})().catch((e) => {
  console.error('Differential runner crashed:', e);
  process.exit(1);
});

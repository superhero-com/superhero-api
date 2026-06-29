#!/usr/bin/env node
/*
 * DEX data-invariant smoke test — a DIFFERENT angle from the endpoint-status
 * smoke. Instead of "did the endpoint return 2xx", it asserts that the DATA is
 * internally consistent ACROSS endpoints, which is where this feature's bugs
 * have actually lived:
 *
 *   1. price values are finite, non-negative and within the chartable range
 *      (catches dust-pool artifacts like 1 token = 2e18 AE);
 *   2. price ↔ chart UNIT agreement: a token with a non-null AE price must have
 *      an AE-denominated chart; a chart denominated in another token must NOT be
 *      paired with a confident AE price (catches "1 AE vs 0.25 TAEX9-A");
 *   3. pair-summary volume is monotonic: 24h ≤ 7d ≤ 30d ≤ total.
 *
 * No DB, no app boot, zero dependencies (global fetch). Exits non-zero on any
 * violation so CI fails loudly.
 *
 * Usage: SMOKE_BASE_URL=https://api.dev.tokensale.org node scripts/smoke-dex-invariants.mjs
 */

const BASE = (process.env.SMOKE_BASE_URL || 'https://api.dev.tokensale.org')
  .replace(/\/+$/, '');
const API = `${BASE}/api/dex`;
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 20000);
const MAX_SANE_PRICE = 90071992547409.91; // chartable upper bound
const SAMPLE = Number(process.env.SMOKE_SAMPLE || 12); // tokens/pairs to deep-check

let pass = 0;
const failures = [];

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

function ok(name) {
  pass++;
  process.stdout.write('.');
}
function bad(name, detail) {
  failures.push(`${name} — ${detail}`);
  process.stdout.write('F');
}
function assert(cond, name, detail) {
  if (cond) ok(name);
  else bad(name, detail);
}

(async () => {
  console.log(`DEX invariant smoke at ${API} (sample=${SAMPLE})\n`);

  const tokensRes = await getJson('/tokens?limit=100');
  const pairsRes = await getJson('/pairs?limit=100');
  const tokens = tokensRes?.items || [];
  const pairs = pairsRes?.items || [];
  if (!tokens.length || !pairs.length) {
    console.error(`FATAL: no tokens/pairs returned (tokens=${tokens.length}, pairs=${pairs.length})`);
    process.exit(1);
  }

  // --- Invariant 1: every token price is finite/bounded/non-negative ---
  for (const t of tokens) {
    const v = t?.price?.ae;
    if (v == null) {
      ok(`price-null ${t.symbol}`); // null = "no AE price" is allowed
      continue;
    }
    const p = Number(v);
    assert(
      Number.isFinite(p) && p >= 0 && p < MAX_SANE_PRICE,
      `price-sane ${t.symbol}`,
      `price.ae=${v} (must be finite, ≥0, <${MAX_SANE_PRICE})`,
    );
  }

  // --- Invariant 2: computed /price sanity + price ↔ chart-unit agreement ---
  // Checked for EVERY token (the computed /price can differ from the stored list
  // value). A token whose history is denominated in a NON-AE token
  // (convertedTo != 'ae') is not AE-priceable through that pool; pairing that
  // with a confident AE price is the "1 AE vs 0.25 OTHER" inconsistency, and an
  // un-bounded dust price (2e18) is caught by the sanity check.
  for (const t of tokens) {
    const [priceRes, hist] = await Promise.all([
      getJson(`/tokens/${t.address}/price`),
      getJson(`/tokens/${t.address}/history?interval=86400&limit=1`),
    ]);
    const cp = priceRes?.price;

    if (cp == null) {
      ok(`computed-price-null ${t.symbol}`);
    } else {
      const p = Number(cp);
      assert(
        Number.isFinite(p) && p >= 0 && p < MAX_SANE_PRICE,
        `computed-price-sane ${t.symbol}`,
        `/price=${cp} (must be finite, ≥0, <${MAX_SANE_PRICE})`,
      );
    }

    const candle = Array.isArray(hist) ? hist[0] : null;
    const convertedTo = candle?.quote?.convertedTo;
    if (convertedTo && convertedTo !== 'ae') {
      // Chart is denominated in another token → a confident AE price misleads.
      assert(
        cp == null || t.symbol === 'WAE',
        `unit-consistency ${t.symbol}`,
        `chart is in '${convertedTo}' but /price=${cp} (expected null)`,
      );
    } else {
      ok(`unit ${t.symbol}`);
    }
  }

  // --- Invariant 3: pair-summary volume monotonicity (sampled) ---
  const samplePairs = pairs.slice(0, SAMPLE);
  for (const p of samplePairs) {
    const sum = await getJson(`/pairs/${p.address}/summary`);
    if (sum?.__status || sum?.__error) {
      bad(`summary ${p.address.slice(0, 10)}`, `summary fetch failed (${sum.__status || sum.__error})`);
      continue;
    }
    const total = Number(sum?.total_volume?.ae ?? 0);
    const v24 = Number(sum?.change?.['24h']?.volume?.ae ?? 0);
    const v7 = Number(sum?.change?.['7d']?.volume?.ae ?? 0);
    const v30 = Number(sum?.change?.['30d']?.volume?.ae ?? 0);
    const EPS = 1e-6; // float slack
    assert(
      v24 <= v7 + EPS && v7 <= v30 + EPS && v30 <= total + EPS,
      `volume-monotonic ${p.token0?.symbol}/${p.token1?.symbol}`,
      `24h=${v24} 7d=${v7} 30d=${v30} total=${total} (must be non-decreasing)`,
    );
  }

  console.log(`\n\n${pass} passed, ${failures.length} failed.`);
  if (failures.length) {
    console.log('\nViolations:');
    for (const f of failures) console.log(`  x ${f}`);
    process.exit(1);
  }
  console.log('All DEX invariants hold.');
})().catch((e) => {
  console.error('Invariant runner crashed:', e);
  process.exit(1);
});

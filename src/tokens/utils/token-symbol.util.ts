/**
 * A token's name and symbol are its on-chain community name verbatim, and every
 * BCL collection permits only uppercase letters (WORDS: `A-Z`, RUSSIAN: `А-Я`)
 * or a caseless script (CHINESE, ARABIC). So a stored symbol is always already
 * in this form, and folding the *caller's* input onto it is enough to make a
 * lookup case-insensitive — without wrapping the column in `UPPER()`, which
 * would give up the btree indexes on `token.name` / `token.symbol`.
 */
export function normalizeTokenSymbol(symbol: string): string {
  return (symbol ?? '').trim().toUpperCase();
}

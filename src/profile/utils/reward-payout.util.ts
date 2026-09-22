import BigNumber from 'bignumber.js';
import { toAe } from '@aeternity/aepp-sdk';
import { ACTIVE_NETWORK } from '@/configs/network';

/**
 * Shared by the operator explorer and the user-facing reward history, so both
 * answer "was this paid, and where is the transaction" the same way.
 */

export type PayoutStatus = 'paid' | 'pending' | 'failed' | 'skipped';

/**
 * What a payout row's status actually is.
 *
 * The `status` column alone is not it. A retry never resets it: claiming a
 * payout writes an in-progress sentinel into `tx_hash`, and a broadcast whose
 * DB confirmation failed writes a real hash, and neither touches `status`. So a
 * row retrying after an earlier failure still reads 'failed', and ranking
 * status first prints "failed" next to a live explorer link. `tx_hash` is
 * written later in the lifecycle, so it wins — only a failed row carrying no
 * hash at all is a genuinely dead send.
 */
export function payoutStatus(row: {
  status?: string | null;
  tx_hash?: string | null;
}): PayoutStatus {
  if (row.status === 'paid') return 'paid';
  // `skipped` (a malformed amount, say) is terminal and outranks `tx_hash`:
  // nothing is retried from it — the payout passes only ever select `pending`
  // and `failed` — so folding it into `pending` would show money as in flight
  // that is never going to move. Only the onboarding row lacks this state.
  if (row.status === 'skipped') return 'skipped';
  if (row.tx_hash) return 'pending';
  if (row.status === 'failed') return 'failed';
  return 'pending';
}

/**
 * A real æternity transaction hash, as opposed to one of the in-progress
 * sentinels the payout services write into `tx_hash` while a send is mid-flight.
 * Every genuine hash is `th_`-prefixed base58; no sentinel is.
 */
export function isRealTxHash(
  txHash: string | null | undefined,
): txHash is string {
  return !!txHash && /^th_[1-9A-HJ-NP-Za-km-z]+$/.test(txHash);
}

/**
 * Null unless the hash is a real one: linking a sentinel to a block explorer
 * would produce a confident 404, which is worse than showing nothing.
 */
export function explorerTxUrl(
  txHash: string | null | undefined,
): string | null {
  if (!isRealTxHash(txHash)) return null;
  const base = (ACTIVE_NETWORK?.explorerUrl || '').replace(/\/+$/, '');
  return base ? `${base}/transactions/${txHash}` : null;
}

/**
 * Amounts are stored in aettos. Formatted server-side because 50 AE is 5e19
 * aettos — past Number.MAX_SAFE_INTEGER, so parsing it as a JS number in the
 * browser would quietly round it.
 */
export function aettosToAe(
  amountAettos: string | null | undefined,
): string | null {
  if (!amountAettos) return null;
  try {
    return new BigNumber(toAe(amountAettos)).toFixed();
  } catch {
    return null;
  }
}

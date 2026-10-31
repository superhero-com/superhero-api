export interface LedgerEntry {
  id: string;
  tx: string;
  at: number;
  height: number;
  confirmations: number;
  action: string;
  actor: string;
  beneficiary: string;
  amount: string;
  shortId?: string;
  source?: string;
}
export interface LedgerReport {
  syncedAt: number;
  stale: boolean;
  message: string;
  confirmationsRequired: number;
  earned: string;
  paidLikes: number;
  pending: number;
  entries: (LedgerEntry & { amountAe: string; confirmed: boolean })[];
  truncated?: boolean;
  series?: { at: number; earnedAe: string; paidLikes: number }[];
}

// Nest injection token shared by the hosted index and the isolated local preview.
export abstract class ShortsLedgerService {
  readonly realtime: boolean = false;
  abstract report(
    actor: string,
    start: number,
    end: number,
    shortId?: string,
  ): LedgerReport | Promise<LedgerReport>;
}

import { encode, Encoding } from '@aeternity/aepp-sdk';

export type RewardMemoKind =
  'onboarding' | 'per_post' | 'streak_bonus' | 'invite_milestone';

/**
 * The note carried by a reward payout on-chain, so the transaction itself says
 * what it was for: on æScan, in any wallet that shows payloads, and to anyone
 * reading the chain without our API.
 *
 * Public forever, so it names the program and nothing else — no X handle,
 * tweet id or date. It must also never start with `TIP_`: the tipping indexers
 * (social-tipping plugin, TipService) read any SpendTx payload with that
 * prefix as a tip.
 */
export function rewardMemoText(
  kind: RewardMemoKind,
  detail?: { streakDays?: number; invites?: number },
): string {
  switch (kind) {
    case 'onboarding':
      return 'Superhero X reward: welcome';
    case 'per_post':
      return 'Superhero X reward: post';
    case 'streak_bonus':
      return detail?.streakDays
        ? `Superhero X reward: ${detail.streakDays}-day streak`
        : 'Superhero X reward: streak';
    case 'invite_milestone':
      return detail?.invites
        ? `Superhero X reward: ${detail.invites} invites`
        : 'Superhero X reward: invites';
    default:
      return 'Superhero X reward';
  }
}

/** {@link rewardMemoText}, encoded as the `payload` a SpendTx takes. */
export function rewardMemoPayload(
  kind: RewardMemoKind,
  detail?: { streakDays?: number; invites?: number },
): `ba_${string}` {
  return encode(
    Buffer.from(rewardMemoText(kind, detail), 'utf8'),
    Encoding.Bytearray,
  );
}

/**
 * `sdk.spend` options with the reward memo attached.
 *
 * `spend` hands every option straight to the transaction builder, `payload`
 * included — the frontend's tips ride on exactly this — but the SDK's
 * `SpendOptions` type drops the field (an `Omit` over a union of all tx
 * params keeps only their common keys), so passing it inline fails to compile.
 * The cast lives here, once, instead of at every payout.
 */
export function withRewardMemo<T extends object>(
  options: T,
  kind: RewardMemoKind,
  detail?: { streakDays?: number; invites?: number },
): T {
  return { ...options, payload: rewardMemoPayload(kind, detail) } as T;
}

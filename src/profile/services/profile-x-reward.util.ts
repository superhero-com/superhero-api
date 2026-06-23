import { toAettos } from '@aeternity/aepp-sdk';
import { Logger } from '@nestjs/common';
import type { FollowerTier } from '../profile.constants';

type ErrorLogger = Pick<Logger, 'error'>;

/**
 * Pick the highest tier whose `minFollowers` is <= `followerCount`. Tiers are
 * expected sorted ascending by `minFollowers` (as built in profile.constants).
 * Returns null when the count is below the lowest configured tier (no reward).
 */
export function resolveFollowerTier(
  tiers: FollowerTier[],
  followerCount: number,
): FollowerTier | null {
  if (!Array.isArray(tiers) || !Number.isFinite(followerCount)) {
    return null;
  }
  let chosen: FollowerTier | null = null;
  for (const tier of tiers) {
    if (followerCount >= tier.minFollowers) {
      chosen = tier;
    } else {
      break;
    }
  }
  return chosen;
}

export function normalizeXUsername(value: string): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/^@+/, '');
  return normalized || null;
}

function safeParseUrl(candidate: string): URL | null {
  const trimmed = (candidate || '').trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
}

/**
 * Derive the canonical host (lowercased, `www.` stripped) from a referral base
 * URL. Returns null when the base URL is empty/unparseable, in which case
 * referral matching falls back to a host-less substring check.
 */
export function extractReferralHost(baseUrl: string): string | null {
  const parsed = safeParseUrl(baseUrl);
  if (!parsed) {
    return null;
  }
  return parsed.host.toLowerCase().replace(/^www\./, '');
}

/**
 * True if any of a tweet's candidate URLs carries this user's referral code.
 *
 * Primary check is host-pinned: the URL host must equal the configured referral
 * host AND its `?ref=` query param must equal the code (case-insensitive). This
 * blocks spoofing such as `evil.com?ref=<code>`. A substring fallback handles
 * X's truncated `display_url` values (scheme-less, may end in an ellipsis), but
 * only when the candidate has no scheme and STARTS with the configured host
 * followed by a path/query boundary — `evil.com/?u=<host>&ref=<code>` and
 * `<host>.evil.com/?ref=<code>` are rejected.
 */
export function matchesReferralCode(params: {
  candidateUrls: string[];
  referralCode: string | null | undefined;
  referralHost: string | null;
}): boolean {
  const code = (params.referralCode || '').trim().toLowerCase();
  if (!code) {
    return false;
  }
  const needle = `ref=${code}`;
  for (const raw of params.candidateUrls || []) {
    const candidate = (raw || '').trim();
    if (!candidate) {
      continue;
    }
    const lowered = candidate.toLowerCase();

    const parsed = safeParseUrl(candidate);
    if (parsed) {
      const host = parsed.host.toLowerCase().replace(/^www\./, '');
      const refParam = (parsed.searchParams.get('ref') || '').toLowerCase();
      if (
        refParam === code &&
        (!params.referralHost || host === params.referralHost)
      ) {
        return true;
      }
    }

    if (lowered.includes(needle)) {
      if (!params.referralHost) {
        return true;
      }
      if (!lowered.includes('://')) {
        const withoutWww = lowered.replace(/^www\./, '');
        const afterHost = withoutWww.slice(
          params.referralHost.length,
          params.referralHost.length + 1,
        );
        if (
          withoutWww.startsWith(params.referralHost) &&
          (afterHost === '' ||
            afterHost === '/' ||
            afterHost === '?' ||
            afterHost === '#')
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

export function isValidAeAmount(value: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    return false;
  }

  return Number(value) > 0;
}

export function isValidPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function getRewardAmountAettos(params: {
  amountAe: string;
  logger: ErrorLogger;
  rewardLabel: string;
}): string | null {
  try {
    const amount = toAettos(params.amountAe);
    if (!/^\d+$/.test(amount) || amount === '0') {
      params.logger.error(
        `Skipping ${params.rewardLabel}, converted aettos amount is invalid: ${amount}`,
      );
      return null;
    }

    return amount;
  } catch (error) {
    params.logger.error(
      `Skipping ${params.rewardLabel}, failed to convert amount to aettos`,
      error instanceof Error ? error.stack : String(error),
    );
    return null;
  }
}

export async function processAddressWithGuard(params: {
  address: string;
  processingByAddress: Map<string, Promise<void>>;
  workFactory: () => Promise<void>;
  logger: ErrorLogger;
  errorMessage: string;
}): Promise<void> {
  const existingInFlight = params.processingByAddress.get(params.address);
  if (existingInFlight) {
    return existingInFlight;
  }

  const work = params.workFactory().catch((error) => {
    params.logger.error(
      params.errorMessage,
      error instanceof Error ? error.stack : String(error),
    );
  });
  params.processingByAddress.set(params.address, work);

  try {
    await work;
  } finally {
    if (params.processingByAddress.get(params.address) === work) {
      params.processingByAddress.delete(params.address);
    }
  }
}

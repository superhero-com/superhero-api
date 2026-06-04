import {
  extractReferralHost,
  matchesReferralCode,
  resolveFollowerTier,
} from './profile-x-reward.util';
import type { FollowerTier } from '../profile.constants';

describe('resolveFollowerTier', () => {
  const tiers: FollowerTier[] = [
    { minFollowers: 0, amountAe: '0.1', index: 0 },
    { minFollowers: 1000, amountAe: '0.5', index: 1 },
    { minFollowers: 10000, amountAe: '1', index: 2 },
  ];

  it('selects the highest tier at or below the follower count', () => {
    expect(resolveFollowerTier(tiers, 0)?.index).toBe(0);
    expect(resolveFollowerTier(tiers, 999)?.index).toBe(0);
    expect(resolveFollowerTier(tiers, 1000)?.index).toBe(1);
    expect(resolveFollowerTier(tiers, 5000)?.index).toBe(1);
    expect(resolveFollowerTier(tiers, 10000)?.index).toBe(2);
    expect(resolveFollowerTier(tiers, 999999)?.index).toBe(2);
  });

  it('returns null below the lowest tier or for invalid input', () => {
    const above: FollowerTier[] = [
      { minFollowers: 1000, amountAe: '0.5', index: 0 },
    ];
    expect(resolveFollowerTier(above, 0)).toBeNull();
    expect(resolveFollowerTier(above, 999)).toBeNull();
    expect(resolveFollowerTier(tiers, Number.NaN)).toBeNull();
    expect(resolveFollowerTier([], 100)).toBeNull();
    expect(resolveFollowerTier(undefined as any, 100)).toBeNull();
  });
});

describe('extractReferralHost', () => {
  it('derives a lowercased, www-stripped host', () => {
    expect(extractReferralHost('https://superhero.com/r')).toBe(
      'superhero.com',
    );
    expect(extractReferralHost('https://www.Superhero.com/r')).toBe(
      'superhero.com',
    );
    expect(extractReferralHost('superhero.com/r')).toBe('superhero.com');
  });

  it('returns null for empty/unparseable input', () => {
    expect(extractReferralHost('')).toBeNull();
    expect(extractReferralHost('   ')).toBeNull();
  });
});

describe('matchesReferralCode', () => {
  const referralHost = 'superhero.com';

  it('matches a host-pinned ref param case-insensitively with extra params', () => {
    expect(
      matchesReferralCode({
        candidateUrls: ['https://superhero.com/r?ref=ABcd12&utm=x'],
        referralCode: 'abcd12',
        referralHost,
      }),
    ).toBe(true);
  });

  it('matches www-prefixed host', () => {
    expect(
      matchesReferralCode({
        candidateUrls: ['https://www.superhero.com/r?ref=abcd12'],
        referralCode: 'abcd12',
        referralHost,
      }),
    ).toBe(true);
  });

  it('rejects a spoofed host carrying the ref param', () => {
    expect(
      matchesReferralCode({
        candidateUrls: ['https://evil.com/r?ref=abcd12'],
        referralCode: 'abcd12',
        referralHost,
      }),
    ).toBe(false);
  });

  it('rejects a different code', () => {
    expect(
      matchesReferralCode({
        candidateUrls: ['https://superhero.com/r?ref=zzzz99'],
        referralCode: 'abcd12',
        referralHost,
      }),
    ).toBe(false);
  });

  it('rejects the code in plain text but not a URL', () => {
    expect(
      matchesReferralCode({
        candidateUrls: [],
        referralCode: 'abcd12',
        referralHost,
      }),
    ).toBe(false);
  });

  it('supports a truncated display_url substring fallback on the right host', () => {
    expect(
      matchesReferralCode({
        candidateUrls: ['superhero.com/r?ref=abcd12'],
        referralCode: 'abcd12',
        referralHost,
      }),
    ).toBe(true);
    // X appends an ellipsis to truncated display URLs; the ref param survives.
    expect(
      matchesReferralCode({
        candidateUrls: ['superhero.com/r?ref=abcd12&utm=…'],
        referralCode: 'abcd12',
        referralHost,
      }),
    ).toBe(true);
    expect(
      matchesReferralCode({
        candidateUrls: ['www.superhero.com/r?ref=abcd12'],
        referralCode: 'abcd12',
        referralHost,
      }),
    ).toBe(true);
  });

  it('rejects a foreign host that merely CONTAINS the referral host and code', () => {
    // Host appears in the query string of another domain.
    expect(
      matchesReferralCode({
        candidateUrls: ['https://evil.com/?u=superhero.com&ref=abcd12'],
        referralCode: 'abcd12',
        referralHost,
      }),
    ).toBe(false);
    // Scheme-less variant of the same trick.
    expect(
      matchesReferralCode({
        candidateUrls: ['evil.com/?u=superhero.com&ref=abcd12'],
        referralCode: 'abcd12',
        referralHost,
      }),
    ).toBe(false);
    // Host-prefix spoof: superhero.com.evil.com.
    expect(
      matchesReferralCode({
        candidateUrls: ['superhero.com.evil.com/r?ref=abcd12'],
        referralCode: 'abcd12',
        referralHost,
      }),
    ).toBe(false);
  });

  it('returns false for an empty referral code', () => {
    expect(
      matchesReferralCode({
        candidateUrls: ['https://superhero.com/r?ref=abcd12'],
        referralCode: '',
        referralHost,
      }),
    ).toBe(false);
  });
});

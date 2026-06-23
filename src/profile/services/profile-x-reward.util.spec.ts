import {
  extractReferralHost,
  getRewardAmountAettos,
  isValidAeAmount,
  isValidPositiveInteger,
  matchesReferralCode,
  normalizeXUsername,
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

describe('matchesReferralCode (additional cases)', () => {
  const referralHost = 'superhero.com';

  it('matches when only the second candidate is the legit host+ref', () => {
    expect(
      matchesReferralCode({
        candidateUrls: [
          'https://evil.com/r?ref=abcd12',
          'https://superhero.com/r?ref=abcd12',
        ],
        referralCode: 'abcd12',
        referralHost,
      }),
    ).toBe(true);
  });

  it('matches a legit host carrying an explicit default port :443', () => {
    // Surprising: WHATWG URL strips the default https port (:443) from
    // `host`, so the host-pinned branch sees plain `superhero.com` and matches.
    expect(
      matchesReferralCode({
        candidateUrls: ['https://superhero.com:443/?ref=abcd12'],
        referralCode: 'abcd12',
        referralHost,
      }),
    ).toBe(true);
  });

  it('rejects a legit host carrying a non-default explicit port :8443', () => {
    // A non-default port is retained in `host` (superhero.com:8443), so the
    // host-pinned comparison fails and there is no scheme-less fallback.
    expect(
      matchesReferralCode({
        candidateUrls: ['https://superhero.com:8443/?ref=abcd12'],
        referralCode: 'abcd12',
        referralHost,
      }),
    ).toBe(false);
  });

  it('matches any URL containing the ref substring when referralHost is null', () => {
    expect(
      matchesReferralCode({
        candidateUrls: ['https://evil.com/?u=superhero.com&ref=abcd12'],
        referralCode: 'abcd12',
        referralHost: null,
      }),
    ).toBe(true);
  });

  it('matches a valid candidate mixed with empty/whitespace entries', () => {
    expect(
      matchesReferralCode({
        candidateUrls: ['', '   ', 'https://superhero.com/r?ref=abcd12', '\t'],
        referralCode: 'abcd12',
        referralHost,
      }),
    ).toBe(true);
  });
});

describe('normalizeXUsername', () => {
  it('strips leading @, trims, and lowercases', () => {
    expect(normalizeXUsername('@Poster')).toBe('poster');
    expect(normalizeXUsername('  @@Foo  ')).toBe('foo');
    expect(normalizeXUsername('BAR')).toBe('bar');
  });

  it('returns null for empty/whitespace-only/@-only input', () => {
    expect(normalizeXUsername('')).toBeNull();
    expect(normalizeXUsername('   ')).toBeNull();
    expect(normalizeXUsername('@')).toBeNull();
    expect(normalizeXUsername('@@@')).toBeNull();
    expect(normalizeXUsername(null as any)).toBeNull();
    expect(normalizeXUsername(undefined as any)).toBeNull();
  });
});

describe('isValidAeAmount', () => {
  it('accepts positive decimal strings', () => {
    expect(isValidAeAmount('1')).toBe(true);
    expect(isValidAeAmount('0.05')).toBe(true);
    expect(isValidAeAmount('50')).toBe(true);
    expect(isValidAeAmount('100.000')).toBe(true);
  });

  it('rejects zero, negatives, and malformed numeric strings', () => {
    expect(isValidAeAmount('0')).toBe(false);
    expect(isValidAeAmount('0.0')).toBe(false);
    expect(isValidAeAmount('-1')).toBe(false);
    expect(isValidAeAmount('1.2.3')).toBe(false);
    expect(isValidAeAmount('abc')).toBe(false);
    expect(isValidAeAmount('')).toBe(false);
    expect(isValidAeAmount('1e3')).toBe(false);
    expect(isValidAeAmount(' 1')).toBe(false);
    expect(isValidAeAmount('.5')).toBe(false);
    expect(isValidAeAmount('1.')).toBe(false);
  });
});

describe('isValidPositiveInteger', () => {
  it('accepts positive integers', () => {
    expect(isValidPositiveInteger(1)).toBe(true);
    expect(isValidPositiveInteger(10)).toBe(true);
  });

  it('rejects zero, negatives, non-integers, and non-finite numbers', () => {
    expect(isValidPositiveInteger(0)).toBe(false);
    expect(isValidPositiveInteger(-1)).toBe(false);
    expect(isValidPositiveInteger(1.5)).toBe(false);
    expect(isValidPositiveInteger(Number.NaN)).toBe(false);
    expect(isValidPositiveInteger(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('getRewardAmountAettos', () => {
  const rewardLabel = 'follower-reward';

  it('converts a valid AE amount to aettos without logging', () => {
    const logger = { error: jest.fn() };
    expect(getRewardAmountAettos({ amountAe: '1', logger, rewardLabel })).toBe(
      '1000000000000000000',
    );
    expect(
      getRewardAmountAettos({ amountAe: '0.1', logger, rewardLabel }),
    ).toBe('100000000000000000');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('returns null and logs when the converted amount is zero', () => {
    const logger = { error: jest.fn() };
    // toAettos('0') === '0', which fails the positive-integer guard.
    expect(
      getRewardAmountAettos({ amountAe: '0', logger, rewardLabel }),
    ).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('returns null and logs when the conversion throws on a non-numeric amount', () => {
    const logger = { error: jest.fn() };
    // toAettos('abc') throws an ArgumentError, caught and logged.
    expect(
      getRewardAmountAettos({ amountAe: 'abc', logger, rewardLabel }),
    ).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('returns null and logs for a negative amount whose aettos are non-numeric for the guard', () => {
    const logger = { error: jest.fn() };
    // toAettos('-1') === '-1000000000000000000', which fails the /^\d+$/ guard.
    expect(
      getRewardAmountAettos({ amountAe: '-1', logger, rewardLabel }),
    ).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

import {
  extractAccountMentions,
  MAX_NOTIFIED_MENTIONS,
} from './account-mentions.util';

const A = 'ak_2a1j2Mk9YSmC1gioUq4PWRm3bsv887MbuRVwyv4KaUGoR1eiKi';
const B = 'ak_28e8EYJ4wcni2KiSqhogHM7G11deM2mLPBcq1iKgVKRmSuAJgJ';
const MANY = [
  'ak_2Nn5Rr2fScJbMj3ZVtV1dkgF7Yc9QDYMATqFL8dAyNzTHGDKWd',
  'ak_2N7YiWdv9DEDuzFepfSwrUBKP52g5UicYMKyzmsHmzaQ7S1MFw',
  'ak_2HW9KmyPuhxLThTPPAzQK1FUEG7feSpPWLUWDpvxUkPCAgnPUG',
  'ak_LvYWdxYwi3GfWAaKsQ2kzqBs6Qnost8NU9Sq11qjJzcDLBPZa',
  'ak_fFurt4NDR6qqtSQMCVDbhdyRLQMH2WFrHsWSxrgowHe4vS7Bp',
  'ak_2Z9R4bKwxc6JqcuKPAmq8TzA46dnh7seGdRQq1VCnxC3yCYBvH',
  'ak_27fecUwjqpWnK15DXtQzR5ZjUCSqyTCpLNPziGysudeoxFrCEs',
  'ak_2Cq8t6TeT9RhU27Cio7jDxVuZjxQfi1AacqBrvFdYMsvrRNX5s',
  'ak_poJ1Q7Z5771DwrAXaU7KpogUakWjbysvPzZ5PrFXmm9boLpbM',
  'ak_D37o9NdYRQMxi1HbkasPT8i87VLo1AVjsTMzUy1xM1fhe2Biy',
  'ak_6Qj1MyaQSsQX2RASPRyhTTEp2Xo7z6hSuoVtzhCdoKDtnaanN',
  'ak_w239VSZsoaUHk3BGFfBXQC9VkVY1wPaJ3DFFDeA6pT4dWk3x9',
];

describe('extractAccountMentions', () => {
  it('returns tagged accounts once, in order of first appearance', () => {
    expect(
      extractAccountMentions(
        `hi [account:${B}] and [account:${A}] [account:${B}]`,
      ),
    ).toEqual([B, A]);
  });

  it('ignores raw addresses and malformed macros', () => {
    expect(
      extractAccountMentions(`${A} [account:ak_short] [account:${A}`),
    ).toEqual([]);
  });

  it('ignores macro-shaped addresses that fail the checksum', () => {
    const ones = `ak_${'1'.repeat(38)}`;
    const badChecksum = 'ak_wNCqvVaG7mrkTVK4RjrjPwsFEgRVuWpkGHdkAp2GRiemN9G1t';
    expect(
      extractAccountMentions(
        `[account:${ones}] [account:${badChecksum}] [account:${A}]`,
      ),
    ).toEqual([A]);
  });

  it('handles empty content', () => {
    expect(extractAccountMentions('')).toEqual([]);
    expect(extractAccountMentions(undefined)).toEqual([]);
    expect(extractAccountMentions(null)).toEqual([]);
  });

  it('caps the number of accounts', () => {
    const content = MANY.map((address) => `[account:${address}]`).join(' ');
    expect(extractAccountMentions(content)).toEqual(
      MANY.slice(0, MAX_NOTIFIED_MENTIONS),
    );
  });
});

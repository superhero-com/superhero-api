import {
  extractAccountMentions,
  MAX_NOTIFIED_MENTIONS,
} from './account-mentions.util';

const A = 'ak_2a1j2Mk9YSmC1gioUq4PWRm3bsv887MbuRVwyv4KaUGoR1eiKi';
const B = 'ak_wNCqvVaG7mrkTVK4RjrjPwsFEgRVuWpkGHdkAp2GRiemN9G1t';

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

  it('handles empty content', () => {
    expect(extractAccountMentions('')).toEqual([]);
    expect(extractAccountMentions(undefined)).toEqual([]);
    expect(extractAccountMentions(null)).toEqual([]);
  });

  it('caps the number of accounts', () => {
    const letters = 'ABCDEFGHJKLMNPQRSTUV';
    const many = letters
      .split('')
      .map((c) => `[account:${A.slice(0, -1)}${c}]`)
      .join(' ');
    expect(extractAccountMentions(many)).toHaveLength(MAX_NOTIFIED_MENTIONS);
  });
});

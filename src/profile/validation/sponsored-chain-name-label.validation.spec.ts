import { BadRequestException } from '@nestjs/common';
import {
  isSponsoredChainNameLabel,
  SponsoredChainNameLabelPipe,
} from './sponsored-chain-name-label.validation';

describe('sponsored chain name label validation', () => {
  it('accepts valid sponsored labels', () => {
    expect(isSponsoredChainNameLabel('myuniquename123')).toBe(true);
    expect(isSponsoredChainNameLabel('my-unique-name')).toBe(true);
  });

  it('rejects labels shorter than 13 characters', () => {
    expect(isSponsoredChainNameLabel('short')).toBe(false);
    expect(isSponsoredChainNameLabel('a'.repeat(12))).toBe(false);
    expect(isSponsoredChainNameLabel('a'.repeat(13))).toBe(true);
  });

  it('rejects uppercase, unicode and underscore labels (>= 13 chars)', () => {
    // These are >= 13 chars, so they are rejected by the charset guard rather
    // than the length check. `isNameValid` alone would accept uppercase and
    // unicode, which the sponsor flow cannot store/compare safely.
    expect(isSponsoredChainNameLabel('InvalidNameHere')).toBe(false);
    expect(isSponsoredChainNameLabel('münchen-cafe123')).toBe(false);
    expect(isSponsoredChainNameLabel('bad_name_here_xx')).toBe(false);
  });

  it('rejects labels with a leading or trailing hyphen', () => {
    expect(isSponsoredChainNameLabel('-leadinghyphen')).toBe(false);
    expect(isSponsoredChainNameLabel('trailinghyphen-')).toBe(false);
  });

  it('throws from the param pipe for invalid labels', () => {
    const pipe = new SponsoredChainNameLabelPipe();

    expect(pipe.transform('myuniquename123', { data: 'name' })).toBe(
      'myuniquename123',
    );
    expect(() => pipe.transform('short', { data: 'name' })).toThrow(
      BadRequestException,
    );
  });
});

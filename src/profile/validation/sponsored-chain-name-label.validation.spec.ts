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

  it('rejects invalid AENS labels', () => {
    expect(isSponsoredChainNameLabel('Invalid-Name')).toBe(false);
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

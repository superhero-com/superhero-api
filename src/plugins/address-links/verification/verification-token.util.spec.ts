import { BadRequestException } from '@nestjs/common';
import {
  createVerificationToken,
  parseVerificationToken,
} from './verification-token.util';

describe('verification-token util', () => {
  const payload = {
    address: 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
    provider: 'bio',
    value: 'hello bio',
    expiry: 1_000_000,
  };

  it('round-trips a payload through create and parse', () => {
    const token = createVerificationToken(payload);
    expect(parseVerificationToken(token)).toEqual(payload);
  });

  it('preserves extra payload fields (e.g. principal)', () => {
    const extended = {
      ...payload,
      provider: 'prefaens',
      principal: 'hero.chain',
    };
    const token = createVerificationToken(extended);
    expect(parseVerificationToken(token)).toEqual(extended);
  });

  it('rejects a token with a tampered payload', () => {
    const token = createVerificationToken(payload);
    const raw = Buffer.from(token, 'base64url').toString('utf-8');
    const dotIdx = raw.lastIndexOf('.');
    // Flip a byte in the JSON payload while keeping the original signature.
    const tampered = `${raw.substring(0, 1)}X${raw.substring(2, dotIdx)}${raw.substring(dotIdx)}`;
    const tamperedToken = Buffer.from(tampered, 'utf-8').toString('base64url');

    expect(() => parseVerificationToken(tamperedToken)).toThrow(
      BadRequestException,
    );
  });

  it('rejects a token with a tampered (non-hex / mis-sized) signature', () => {
    const token = createVerificationToken(payload);
    const raw = Buffer.from(token, 'base64url').toString('utf-8');
    const data = raw.substring(0, raw.lastIndexOf('.'));
    const badSig = Buffer.from(`${data}.zzzz`, 'utf-8').toString('base64url');

    // Must be a clean BadRequestException, not a RangeError from timingSafeEqual.
    expect(() => parseVerificationToken(badSig)).toThrow(BadRequestException);
  });

  it('rejects a malformed token with no signature separator', () => {
    const noDot = Buffer.from('justsomedata', 'utf-8').toString('base64url');
    expect(() => parseVerificationToken(noDot)).toThrow(BadRequestException);
  });
});

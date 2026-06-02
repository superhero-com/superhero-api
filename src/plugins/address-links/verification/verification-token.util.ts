import { BadRequestException } from '@nestjs/common';
import crypto from 'crypto';
import { ADDRESS_LINK_SECRET_KEY } from '../address-links.constants';

/**
 * Base payload carried by a server-signed verification token. Providers that
 * need extra fields (e.g. the preferred AENS principal) extend this.
 */
export interface VerificationTokenPayload {
  address: string;
  provider: string;
  value: string;
  expiry: number;
}

/**
 * Serialize a payload and append an HMAC-SHA256 signature, encoded as a single
 * base64url token. Shared by every claim-time verifier so the token format and
 * signing key stay in one place.
 */
export function createVerificationToken<T extends object>(payload: T): string {
  const data = JSON.stringify(payload);
  const hmac = crypto
    .createHmac('sha256', ADDRESS_LINK_SECRET_KEY)
    .update(data)
    .digest('hex');
  return Buffer.from(`${data}.${hmac}`, 'utf-8').toString('base64url');
}

/**
 * Decode and verify a token produced by {@link createVerificationToken},
 * returning its payload. Throws BadRequestException on any decode, structure
 * or signature failure. Callers are responsible for the semantic checks
 * (expiry, address/provider/value match).
 */
export function parseVerificationToken<T = VerificationTokenPayload>(
  token: string,
): T {
  let raw: string;
  try {
    raw = Buffer.from(token, 'base64url').toString('utf-8');
  } catch {
    throw new BadRequestException('Invalid verification token encoding');
  }

  const dotIdx = raw.lastIndexOf('.');
  if (dotIdx === -1) {
    throw new BadRequestException('Malformed verification token');
  }

  const data = raw.substring(0, dotIdx);
  const providedHmac = raw.substring(dotIdx + 1);

  const expectedHmac = crypto
    .createHmac('sha256', ADDRESS_LINK_SECRET_KEY)
    .update(data)
    .digest('hex');

  // Compare decoded buffers (not hex strings): a tampered token with non-hex
  // or mis-sized signature decodes to a different-length buffer and is rejected
  // here rather than throwing a RangeError out of timingSafeEqual.
  const providedBuf = Buffer.from(providedHmac, 'hex');
  const expectedBuf = Buffer.from(expectedHmac, 'hex');
  if (
    providedBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(providedBuf, expectedBuf)
  ) {
    throw new BadRequestException('Invalid verification token signature');
  }

  try {
    return JSON.parse(data) as T;
  } catch {
    throw new BadRequestException('Invalid verification token payload');
  }
}

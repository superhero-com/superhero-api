import { BadRequestException, Injectable } from '@nestjs/common';
import { ClaimAvatarLinkDto } from '../dto/avatar/claim-avatar-link.dto';
import { SubmitAvatarLinkDto } from '../dto/avatar/submit-avatar-link.dto';
import { ADDRESS_LINK_VERIFICATION_TTL_SECONDS } from '../address-links.constants';
import { VerifiedClaim } from './link-verifier.interface';
import {
  createVerificationToken,
  parseVerificationToken,
} from './verification-token.util';

/** Image file extensions accepted for a profile picture. */
const AVATAR_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

/** Image hosts whose links often carry no file extension. */
const AVATAR_IMAGE_HOSTS = ['imgur.com', 'giphy.com', 'ipfs.io'];

/** Hostname plus path (and optional query); no protocol or port on-chain. */
const AVATAR_VALUE_PATTERN =
  /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(\/[^\s?#]*)(\?[^\s#]*)?$/;

export const AVATAR_MAX_LENGTH = 200;

/**
 * Turns a stored avatar link value (`host/path`) back into a public URL.
 * Avatars are always served over https.
 */
export function avatarLinkToUrl(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? `https://${trimmed}` : null;
}

/**
 * Profile picture link. The image is hosted elsewhere (no upload storage);
 * the account stores an https image URL through the AddressLink contract,
 * signed by the wallet like bio and website.
 */
@Injectable()
export class AvatarLinkVerifierService {
  async verifyClaim(dto: ClaimAvatarLinkDto): Promise<VerifiedClaim> {
    const value = this.normalizeAvatar(dto.value);
    const expiry = Date.now() + ADDRESS_LINK_VERIFICATION_TTL_SECONDS * 1000;
    const verificationToken = createVerificationToken({
      address: dto.address,
      provider: 'avatar',
      value,
      expiry,
    });

    return { value, verificationToken };
  }

  async verifySubmit(dto: SubmitAvatarLinkDto): Promise<void> {
    const value = this.normalizeAvatar(dto.value);
    const payload = parseVerificationToken(dto.verification_token);

    if (Date.now() > payload.expiry) {
      throw new BadRequestException('Verification token has expired');
    }
    if (payload.address !== dto.address) {
      throw new BadRequestException('Verification token address mismatch');
    }
    if (payload.provider !== 'avatar') {
      throw new BadRequestException('Verification token provider mismatch');
    }
    if (payload.value !== value) {
      throw new BadRequestException('Verification token value mismatch');
    }
  }

  /**
   * Accepts `https://host/path.png` (or `host/path.png`) and returns the
   * on-chain form `host/path.png`. The contract value cannot hold ":", so
   * the protocol is dropped and plain http or a port is rejected.
   */
  normalizeAvatar(value: string): string {
    let normalized = (value ?? '').trim();
    if (normalized.length === 0) {
      throw new BadRequestException('Avatar URL must not be empty');
    }
    if (/^http:\/\//i.test(normalized)) {
      throw new BadRequestException('Avatar URL must use https');
    }
    normalized = normalized.replace(/^https:\/\//i, '').replace(/^\/\//, '');
    normalized = normalized.split('#')[0];

    const slash = normalized.indexOf('/');
    if (slash > 0) {
      normalized =
        normalized.slice(0, slash).toLowerCase() + normalized.slice(slash);
    }

    if (normalized.length > AVATAR_MAX_LENGTH) {
      throw new BadRequestException(
        `Avatar URL must be ${AVATAR_MAX_LENGTH} characters or fewer`,
      );
    }
    if (normalized.includes(':')) {
      throw new BadRequestException(
        'Avatar URL must not contain ":" (use an https link without a port)',
      );
    }
    const match = AVATAR_VALUE_PATTERN.exec(normalized);
    if (!match) {
      throw new BadRequestException(
        'Avatar URL must be an https link to an image (e.g. https://example.com/me.png)',
      );
    }

    const host = match[1];
    const path = match[2].toLowerCase();
    const hasImageExtension = AVATAR_IMAGE_EXTENSIONS.some((ext) =>
      path.endsWith(ext),
    );
    const isImageHost = AVATAR_IMAGE_HOSTS.some(
      (h) => host === h || host.endsWith(`.${h}`),
    );
    if (!hasImageExtension && !isImageHost) {
      throw new BadRequestException(
        'Avatar URL must point to an image (.jpg, .jpeg, .png, .gif or .webp)',
      );
    }

    return normalized;
  }
}

import { encode, Encoding, hash } from '@aeternity/aepp-sdk';
import { BadRequestException, Injectable } from '@nestjs/common';
import { OAuthService } from '@/affiliation/services/oauth.service';
import crypto from 'crypto';
import nacl from 'tweetnacl';
import {
  PROFILE_ATTESTATION_PRIVATE_KEY,
  PROFILE_ATTESTATION_SIGNER_ADDRESS,
  PROFILE_ATTESTATION_TTL_SECONDS,
} from '../profile.constants';
import { parseProfilePrivateKeyBytes } from './profile-private-key.util';

@Injectable()
export class ProfileAttestationService {
  constructor(private readonly oauthService: OAuthService) {}

  async createXAttestation(
    address: string,
    options:
      | { accessToken: string }
      | { code: string; code_verifier: string; redirect_uri: string },
  ) {
    if (
      !PROFILE_ATTESTATION_PRIVATE_KEY ||
      !PROFILE_ATTESTATION_SIGNER_ADDRESS
    ) {
      throw new BadRequestException(
        'Profile attestation signer is not configured',
      );
    }

    const accessToken =
      'accessToken' in options
        ? options.accessToken
        : await this.oauthService.exchangeXCodeForAccessToken(
            options.code,
            options.code_verifier,
            options.redirect_uri,
          );

    const oauthUser = await this.oauthService.verifyAccessToken(
      'x',
      accessToken,
    );
    const xUsername = oauthUser.username || oauthUser.name;
    if (!xUsername) {
      throw new BadRequestException(
        'Unable to extract X username from OAuth profile',
      );
    }

    const normalizedXUsername = this.normalizeName(xUsername);
    const nonce = crypto.randomBytes(12).toString('hex');
    // Sophia Chain.timestamp is in milliseconds; keep attestation expiry in ms too.
    const expiry = Date.now() + PROFILE_ATTESTATION_TTL_SECONDS * 1000;
    const message = this.createAttestationMessage(
      address,
      normalizedXUsername,
      expiry,
      nonce,
    );

    const privateKey = this.parsePrivateKey(PROFILE_ATTESTATION_PRIVATE_KEY);
    this.validateSignerAddress(privateKey);
    const signature = this.signForContract(message, privateKey);
    const signatureHex = Buffer.from(signature).toString('hex');

    return {
      signer: PROFILE_ATTESTATION_SIGNER_ADDRESS,
      address,
      x_username: normalizedXUsername,
      nonce,
      expiry,
      message,
      signature_hex: signatureHex,
      signature_base64: Buffer.from(signature).toString('base64'),
    };
  }

  createAttestationMessage(
    address: string,
    xUsername: string,
    expiry: number,
    nonce: string,
  ): string {
    return `profile_x_attestation:${address}:${xUsername}:${expiry}:${nonce}`;
  }

  normalizeName(value: string): string {
    return value.trim().toLowerCase();
  }

  private parsePrivateKey(privateKey: string): Buffer {
    try {
      return this.normalizeSecretKey(
        Buffer.from(parseProfilePrivateKeyBytes(privateKey)),
      );
    } catch {
      throw new BadRequestException(
        'PROFILE_ATTESTATION_PRIVATE_KEY must be 32-byte seed or 64-byte secret key',
      );
    }
  }

  private normalizeSecretKey(secretOrSeed: Buffer): Buffer {
    if (secretOrSeed.length === 64) {
      return secretOrSeed;
    }
    if (secretOrSeed.length === 32) {
      // 32-byte Ed25519 seed -> 64-byte secret key expected by nacl.sign
      return Buffer.from(nacl.sign.keyPair.fromSeed(secretOrSeed).secretKey);
    }
    throw new BadRequestException(
      'PROFILE_ATTESTATION_PRIVATE_KEY must be 32-byte seed or 64-byte secret key',
    );
  }

  private signForContract(message: string, secretKey: Buffer): Uint8Array {
    // Must mirror contract `prefix_message_hashed` exactly:
    // digest = "aeternity Signed Message:\n " prefix bytes + blake2b(message)
    // Use aepp-sdk hash() (Blake2b-256), same primitive used in the Aeternity stack.
    const msgHash = hash(Buffer.from(message, 'utf-8'));
    const prefix = Buffer.from(
      '1a61657465726e697479205369676e6564204d6573736167653a0a20',
      'hex',
    );
    const digest = Buffer.concat([prefix, msgHash]);
    return nacl.sign.detached(digest, secretKey);
  }

  private validateSignerAddress(secretKey: Buffer) {
    const publicKey = nacl.sign.keyPair.fromSecretKey(secretKey).publicKey;
    const derivedSigner = encode(
      Buffer.from(publicKey),
      Encoding.AccountAddress,
    );
    if (derivedSigner !== PROFILE_ATTESTATION_SIGNER_ADDRESS) {
      throw new BadRequestException(
        `PROFILE_ATTESTATION_SIGNER_ADDRESS mismatch. Expected ${derivedSigner} from private key but got ${PROFILE_ATTESTATION_SIGNER_ADDRESS}`,
      );
    }
  }
}

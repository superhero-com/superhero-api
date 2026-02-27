import { decode } from '@aeternity/aepp-sdk';

export const parseProfilePrivateKeyBytes = (privateKey: string): Uint8Array => {
  if (privateKey.startsWith('sk_')) {
    return normalizePrivateKeyLength(
      Uint8Array.from(decode(privateKey as any)),
    );
  }

  const normalizedHex = privateKey.startsWith('0x')
    ? privateKey.slice(2)
    : privateKey;
  if (
    normalizedHex.length > 0 &&
    normalizedHex.length % 2 === 0 &&
    /^[a-fA-F0-9]+$/.test(normalizedHex)
  ) {
    return normalizePrivateKeyLength(
      Uint8Array.from(Buffer.from(normalizedHex, 'hex')),
    );
  }

  return normalizePrivateKeyLength(
    Uint8Array.from(Buffer.from(privateKey, 'base64')),
  );
};

const normalizePrivateKeyLength = (privateKeyBytes: Uint8Array): Uint8Array => {
  if (privateKeyBytes.length === 32 || privateKeyBytes.length === 64) {
    return privateKeyBytes;
  }
  throw new Error('Private key must be a 32-byte seed or 64-byte secret key');
};

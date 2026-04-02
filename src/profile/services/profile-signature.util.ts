import { decode, verifyMessageSignature } from '@aeternity/aepp-sdk';

export function verifyAeAddressSignature(
  address: string,
  message: string,
  signatureHex: string,
): boolean {
  try {
    let signatureBytes: Uint8Array;
    if (signatureHex.startsWith('sg_')) {
      signatureBytes = Uint8Array.from(decode(signatureHex as any));
    } else {
      signatureBytes = Uint8Array.from(Buffer.from(signatureHex, 'hex'));
    }
    if (signatureBytes.length !== 64) {
      return false;
    }
    return verifyMessageSignature(
      message,
      signatureBytes,
      address as `ak_${string}`,
    );
  } catch {
    return false;
  }
}

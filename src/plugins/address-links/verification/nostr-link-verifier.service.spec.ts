import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  nip19,
} from 'nostr-tools';
import { ADDRESS_LINK_NOSTR_EVENT_MAX_AGE_SECONDS } from '../address-links.constants';
import { NostrLinkVerifierService } from './nostr-link-verifier.service';

const ADDRESS = 'ak_alice';
const NONCE = 3;
const NOW_SECONDS = 1_800_000_000;

const ownerKey = generateSecretKey();
const ownerPubkey = getPublicKey(ownerKey);
const ownerNpub: string = nip19.npubEncode(ownerPubkey);
const attackerKey = generateSecretKey();

const linkMessage = (address = ADDRESS, nonce = NONCE, value = ownerNpub) =>
  `link:${address}:nostr:${value}:${nonce}`;

function signedEvent(
  content: string,
  key = ownerKey,
  overrides: { kind?: number; created_at?: number } = {},
) {
  return finalizeEvent(
    { kind: 22242, created_at: NOW_SECONDS, tags: [], content, ...overrides },
    key,
  );
}

describe('NostrLinkVerifierService', () => {
  const verifier = new NostrLinkVerifierService();

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW_SECONDS * 1000);
  });

  afterEach(() => jest.restoreAllMocks());

  const submit = (
    event: object | string,
    { value = ownerNpub, expected = linkMessage() } = {},
  ) =>
    verifier.verifySubmit(
      {
        address: ADDRESS,
        value,
        nonce: NONCE,
        signature: 'a'.repeat(128),
        nostr_event: typeof event === 'string' ? event : JSON.stringify(event),
      },
      expected,
    );

  const notAnNpub: Array<[string, string]> = [
    ['an nsec', nip19.nsecEncode(ownerKey)],
    ['a note id', nip19.noteEncode('0'.repeat(64))],
    ['a hex pubkey', ownerPubkey],
    ['garbage', 'npub1notbech32'],
    ['an uppercase npub', ownerNpub.toUpperCase()],
  ];

  describe('verifyClaim', () => {
    it('accepts an npub as is', async () => {
      await expect(
        verifier.verifyClaim({ address: ADDRESS, value: ownerNpub }),
      ).resolves.toEqual({ value: ownerNpub });
    });

    it.each(notAnNpub)('refuses %s', async (_, value) => {
      await expect(
        verifier.verifyClaim({ address: ADDRESS, value }),
      ).rejects.toThrow('Invalid npub format');
    });
  });

  describe('verifySubmit', () => {
    it("accepts the npub owner's signature over the exact link message", async () => {
      await expect(submit(signedEvent(linkMessage()))).resolves.toBeUndefined();
    });

    it('refuses an event signed by a key other than the claimed npub', async () => {
      await expect(
        submit(signedEvent(linkMessage(), attackerKey)),
      ).rejects.toThrow('Nostr event pubkey does not match the claimed npub');
    });

    it("refuses the owner's pubkey carrying another key's signature", async () => {
      const event: Record<string, unknown> = {
        ...signedEvent(linkMessage(), attackerKey),
        pubkey: ownerPubkey,
      };
      event.id = getEventHash(event as any);

      await expect(submit(event)).rejects.toThrow(
        'Nostr event signature is invalid',
      );
    });

    it('refuses content edited after signing', async () => {
      const event = {
        ...signedEvent(linkMessage(ADDRESS, NONCE + 1)),
        content: linkMessage(),
      };

      await expect(submit(event)).rejects.toThrow(
        'Nostr event signature is invalid',
      );
    });

    it.each([
      ['another address', linkMessage('ak_mallory')],
      ['another nonce', linkMessage(ADDRESS, NONCE + 1)],
      ['another provider', `link:${ADDRESS}:x:${ownerNpub}:${NONCE}`],
    ])('refuses a signature made for %s', async (_, content) => {
      await expect(submit(signedEvent(content))).rejects.toThrow(
        'Nostr event content does not match expected link message',
      );
    });

    it('refuses an event that is not a NIP-42 auth event', async () => {
      await expect(
        submit(signedEvent(linkMessage(), ownerKey, { kind: 1 })),
      ).rejects.toThrow('Nostr event must be kind 22242');
    });

    it.each([
      ['at the maximum age', -ADDRESS_LINK_NOSTR_EVENT_MAX_AGE_SECONDS],
      ['60s in the future', 60],
    ])('accepts an event %s', async (_, offset) => {
      await expect(
        submit(
          signedEvent(linkMessage(), ownerKey, {
            created_at: NOW_SECONDS + offset,
          }),
        ),
      ).resolves.toBeUndefined();
    });

    it.each([
      [
        'older than the maximum age',
        -ADDRESS_LINK_NOSTR_EVENT_MAX_AGE_SECONDS - 1,
      ],
      ['more than 60s in the future', 61],
    ])('refuses an event %s', async (_, offset) => {
      await expect(
        submit(
          signedEvent(linkMessage(), ownerKey, {
            created_at: NOW_SECONDS + offset,
          }),
        ),
      ).rejects.toThrow('Nostr event timestamp is out of acceptable range');
    });

    it('refuses an event that is not JSON', async () => {
      await expect(submit('{not json')).rejects.toThrow(
        'nostr_event must be valid JSON',
      );
    });

    it.each(['null', '[]', '"text"', '42'])(
      'refuses %s as the event',
      async (raw) => {
        await expect(submit(raw)).rejects.toThrow(
          'nostr_event must be a JSON object',
        );
      },
    );

    it.each([
      ['missing', undefined],
      ['a string', String(NOW_SECONDS)],
      ['a fraction', NOW_SECONDS + 0.5],
    ])('refuses an event whose timestamp is %s', async (_, createdAt) => {
      const event = { ...signedEvent(linkMessage()), created_at: createdAt };

      await expect(submit(event)).rejects.toThrow(
        'Nostr event timestamp is out of acceptable range',
      );
    });

    it.each(notAnNpub)('refuses %s as the value', async (_, value) => {
      const expected = linkMessage(ADDRESS, NONCE, value);

      await expect(
        submit(signedEvent(expected), { value, expected }),
      ).rejects.toThrow('Invalid npub format');
    });
  });
});

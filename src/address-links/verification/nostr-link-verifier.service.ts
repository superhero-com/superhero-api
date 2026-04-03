import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { verifyEvent, nip19, type Event as NostrEvent } from 'nostr-tools';
import { ClaimLinkDto } from '../dto/claim-link.dto';
import { SubmitLinkDto } from '../dto/submit-link.dto';
import { ADDRESS_LINK_NOSTR_EVENT_MAX_AGE_SECONDS } from '../address-links.constants';
import { LinkVerifier, VerifiedClaim } from './link-verifier.interface';

const AUTH_EVENT_KIND = 22242;

@Injectable()
export class NostrLinkVerifierService implements LinkVerifier {
  private readonly logger = new Logger(NostrLinkVerifierService.name);

  async verifyClaim(
    _address: string,
    dto: ClaimLinkDto,
  ): Promise<VerifiedClaim> {
    if (!dto.value) {
      throw new BadRequestException(
        'value (npub) is required for nostr link claim',
      );
    }
    this.decodeNpub(dto.value);
    return { value: dto.value };
  }

  async verifySubmit(
    dto: SubmitLinkDto,
    expectedMessage: string,
  ): Promise<void> {
    if (!dto.nostr_event) {
      throw new BadRequestException(
        'nostr_event is required for nostr link submission',
      );
    }

    let event: NostrEvent;
    try {
      event = JSON.parse(dto.nostr_event);
    } catch {
      throw new BadRequestException('nostr_event must be valid JSON');
    }

    if (event.kind !== AUTH_EVENT_KIND) {
      throw new BadRequestException(
        `Nostr event must be kind ${AUTH_EVENT_KIND}`,
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const age = now - event.created_at;
    if (age > ADDRESS_LINK_NOSTR_EVENT_MAX_AGE_SECONDS || age < -60) {
      throw new BadRequestException(
        'Nostr event timestamp is out of acceptable range',
      );
    }

    if (event.content !== expectedMessage) {
      throw new BadRequestException(
        'Nostr event content does not match expected link message',
      );
    }

    const expectedPubkeyHex = this.decodeNpub(dto.value);
    if (event.pubkey !== expectedPubkeyHex) {
      throw new BadRequestException(
        'Nostr event pubkey does not match the claimed npub',
      );
    }

    if (!verifyEvent(event)) {
      throw new BadRequestException('Nostr event signature is invalid');
    }
  }

  private decodeNpub(npub: string): string {
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') {
        throw new Error('not an npub');
      }
      return decoded.data as string;
    } catch {
      throw new BadRequestException(
        'Invalid npub format. Must be a valid bech32-encoded Nostr public key.',
      );
    }
  }
}

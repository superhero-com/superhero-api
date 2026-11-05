import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { verifyEvent, nip19, type Event as NostrEvent } from 'nostr-tools';
import { ClaimNostrLinkDto } from '../dto/nostr/claim-nostr-link.dto';
import { SubmitNostrLinkDto } from '../dto/nostr/submit-nostr-link.dto';
import { ADDRESS_LINK_NOSTR_EVENT_MAX_AGE_SECONDS } from '../address-links.constants';
import { VerifiedClaim } from './link-verifier.interface';

const AUTH_EVENT_KIND = 22242;

@Injectable()
export class NostrLinkVerifierService {
  private readonly logger = new Logger(NostrLinkVerifierService.name);

  async verifyClaim(dto: ClaimNostrLinkDto): Promise<VerifiedClaim> {
    this.decodeNpub(dto.value);
    return { value: dto.value };
  }

  async verifySubmit(
    dto: SubmitNostrLinkDto,
    expectedMessage: string,
  ): Promise<void> {
    let event: NostrEvent;
    try {
      event = JSON.parse(dto.nostr_event);
    } catch {
      throw new BadRequestException('nostr_event must be valid JSON');
    }
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      throw new BadRequestException('nostr_event must be a JSON object');
    }

    if (event.kind !== AUTH_EVENT_KIND) {
      throw new BadRequestException(
        `Nostr event must be kind ${AUTH_EVENT_KIND}`,
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const age = now - event.created_at;
    if (
      !Number.isInteger(event.created_at) ||
      age > ADDRESS_LINK_NOSTR_EVENT_MAX_AGE_SECONDS ||
      age < -60
    ) {
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
      // bech32 also decodes the all-uppercase form, which the contract would
      // store as a second value for the same key, dodging its one-link rule.
      if (decoded.type !== 'npub' || npub !== npub.toLowerCase()) {
        throw new Error('not a lowercase npub');
      }
      return decoded.data as string;
    } catch {
      throw new BadRequestException(
        'Invalid npub format. Must be a valid lowercase bech32-encoded Nostr public key.',
      );
    }
  }
}

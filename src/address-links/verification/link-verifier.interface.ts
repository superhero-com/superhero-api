import { ClaimLinkDto } from '../dto/claim-link.dto';
import { SubmitLinkDto } from '../dto/submit-link.dto';

export interface VerifiedClaim {
  /** Canonical value to store on-chain (e.g. normalized X username, npub). */
  value: string;
  /** Server-signed proof for providers that verify at claim time (X). */
  verificationToken?: string;
}

export interface LinkVerifier {
  verifyClaim(address: string, dto: ClaimLinkDto): Promise<VerifiedClaim>;
  verifySubmit(dto: SubmitLinkDto, expectedMessage: string): Promise<void>;
}

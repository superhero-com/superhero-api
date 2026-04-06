export interface VerifiedClaim {
  /** Canonical value to store on-chain (e.g. normalized X username, npub). */
  value: string;
  /** Server-signed proof for providers that verify at claim time (X). */
  verificationToken?: string;
}

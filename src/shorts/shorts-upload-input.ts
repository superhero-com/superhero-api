export interface UploadInput {
  /** Hosted creation identity; a fresh UUID for each deliberate new upload. */
  requestKey?: string;
  /** Optional client precondition; never selects the server's processing profile. */
  expectedFormat?: 'original-file-v1';
  /** Internal only: the hosted adapter replaces any caller-supplied value. */
  acceptedMaxBytes?: number;
  processingProfile?: typeof import('./shorts-rendition-policy').SHORTS_ORIGINAL_PROFILE;
  title: string;
  topic: string;
  rights: boolean;
  bytes: number;
  sha256: string;
  details: {
    description?: string;
    language?: string;
    synthetic?: boolean;
    sponsored?: boolean;
    captions?: string;
  };
}

const minute = 60000;
const MiB = 1024 * 1024;

// Capacity/burst, refill period, deployment-wide burst, authenticated-wallet burst.
export const SHORTS_RATE_GROUPS = {
  read: [300, minute, 3000, 0],
  playback: [1200, minute, 6000, 0],
  health: [30, minute, 120, 0],
  auth: [20, minute, 120, 0],
  studio: [240, minute, 1200, 180],
  measurement: [180, minute, 3000, 0],
  privacy: [6, minute, 120, 0],
  report: [6, minute, 120, 0],
  uploadStart: [12, minute, 60, 6],
  uploadPart: [120, minute, 600, 100],
  uploadControl: [360, minute, 1800, 300],
  uploadFinish: [12, minute, 30, 6],
  publish: [12, minute, 30, 6],
  receipt: [30, minute, 120, 20],
  transactionStatus: [30, minute, 120, 0],
  scan: [6, 3600000, 60, 3],
  appeal: [6, 3600000, 60, 3],
  operator: [60, minute, 120, 60],
  preview: [60, minute, 120, 60],
} as const;

export type ShortsRateGroup = keyof typeof SHORTS_RATE_GROUPS;
export interface ShortsHttpPolicy {
  group: ShortsRateGroup;
  private?: boolean;
  /** Reserve the parser's maximum media bytes before accepting any body. */
  bytes?: number;
}

// Handler names, never a user-supplied path, ID, address or session identifier.
// Every Shorts HTTP handler must have an explicit policy.
export const SHORTS_HTTP_POLICY: Record<string, ShortsHttpPolicy> = {
  config: { group: 'read' },
  playbackHealth: { group: 'health' },
  challenge: { group: 'auth' },
  verify: { group: 'auth' },
  connect: { group: 'auth' },
  logout: { group: 'auth' },
  logoutAll: { group: 'auth', private: true },
  list: { group: 'read' },
  feed: { group: 'read' },
  feedState: { group: 'read' },
  followingFeed: { group: 'read' },
  followingState: { group: 'read' },
  shared: { group: 'read' },
  content: { group: 'studio', private: true },
  dashboard: { group: 'studio', private: true },
  studioContent: { group: 'studio', private: true },
  studioSummary: { group: 'studio', private: true },
  studioVideo: { group: 'studio', private: true },
  performance: { group: 'studio', private: true },
  forget: { group: 'privacy' },
  review: { group: 'operator', private: true },
  // Ownership/operator authorization is checked against the requested video.
  reviewMedia: { group: 'preview', private: true },
  ingestionHealth: { group: 'operator', private: true },
  lifecycleHealth: { group: 'operator', private: true },
  measurementHealth: { group: 'operator', private: true },
  reconcileAccounting: { group: 'operator', private: true },
  moderate: { group: 'operator', private: true },
  startUpload: { group: 'uploadStart', private: true },
  uploadStatus: { group: 'studio', private: true },
  uploadPart: { group: 'uploadPart', private: true, bytes: MiB + 1 },
  prepareDirectPart: { group: 'uploadControl', private: true },
  authorizeDirectPart: { group: 'uploadControl', private: true },
  completeDirectPart: { group: 'uploadControl', private: true },
  finishUpload: { group: 'uploadFinish', private: true },
  upload: { group: 'uploadStart', private: true, bytes: 40 * MiB },
  scan: { group: 'scan', private: true },
  appeal: { group: 'appeal', private: true },
  playback: { group: 'measurement' },
  publication: { group: 'studio', private: true },
  publish: { group: 'publish', private: true },
  receipt: { group: 'receipt', private: true },
  walletTransaction: { group: 'transactionStatus' },
  view: { group: 'measurement' },
  report: { group: 'report' },
  playbackDescriptor: { group: 'playback' },
  media: { group: 'read' },
};

export const SHORTS_RATE_BYTES = {
  ip: 128 * MiB,
  actor: 80 * MiB,
  global: 512 * MiB,
  period: 600000,
};

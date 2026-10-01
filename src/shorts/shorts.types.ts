export type DemoActor = string;
export type FundingSource = 'wallet' | 'rewards';
export interface ShortRecord {
  safety?: import('./shorts-safety.service').VisualSafety;
  visualReviewHash?: string;
  description?: string;
  language?: string;
  synthetic?: boolean;
  sponsored?: boolean;
  captions?: boolean;
  classification?: import('./shorts-labels.service').Classification;
  reviewReason?: string;
  reviewedTopic?: string;
  reviewHistory?: {
    at: number;
    operator: string;
    reason: string;
    approved: boolean;
    topic: string;
  }[];
  appeal?: { message: string; at: number; status: 'pending' | 'resolved' };
  reportDetails?: { id: string; reason: string; detail: string; at: number }[];
  id: string;
  creator: string;
  title: string;
  topic: string;
  cid: string;
  bytes: number;
  duration: number;
  createdAt: number;
  moderation: 'pending' | 'approved' | 'rejected';
  files: { name: string; bytes: number; sha256: string }[];
  views: string[];
  reports: number;
}
export interface LocalState {
  contract?: string;
  sourceHash?: string;
  shorts: ShortRecord[];
  receipts: {
    actor: string;
    action: string;
    tx: string;
    at: number;
    quoteId?: string;
  }[];
}

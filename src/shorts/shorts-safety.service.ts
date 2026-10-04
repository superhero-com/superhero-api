import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export interface VisualSafety {
  status: 'no_flags' | 'review' | 'blocked' | 'error';
  reason: string;
  sourceSha256: string;
  evidenceHash?: string;
  policy?: string;
  models?: Record<string, { repository: string; revision: string }>;
  sampling?: string;
  frameCount?: number;
  maxNsfwScore?: number;
  labels?: { topic: string; score: number }[];
  frames?: {
    at: number;
    sha256: string;
    nsfwScore: number;
    labels: { topic: string; score: number }[];
  }[];
  checkedAt: number;
  thresholds?: { review: number; block: number };
  humanReviewRequired: true;
}
export function visualAllows(short: {
  safety?: VisualSafety;
  visualReviewHash?: string;
}) {
  return (
    short.safety?.status === 'no_flags' ||
    (short.safety?.status === 'review' &&
      !!short.safety.evidenceHash &&
      short.visualReviewHash === short.safety.evidenceHash)
  );
}

@Injectable()
export class ShortsSafetyService {
  readonly demoAutoApprove =
    process.env.SHORTS_DEMO_AUTO_APPROVE === '1' &&
    process.env.SHORTS_TESTNET_MVP === '1' &&
    process.env.NODE_ENV !== 'production';
  private readonly endpoint =
    process.env.SHORTS_MODERATION_URL || 'http://127.0.0.1:3340';
  async health() {
    if (this.demoAutoApprove) return false;
    try {
      const response = await fetch(`${this.endpoint}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok && (await response.json()).ready === true;
    } catch {
      return false;
    }
  }
  async scan(video: Buffer): Promise<VisualSafety | undefined> {
    // Skipping inspection must not create a successful scan receipt.
    if (this.demoAutoApprove) return undefined;
    const base = {
      sourceSha256: createHash('sha256').update(video).digest('hex'),
      checkedAt: Date.now(),
      humanReviewRequired: true as const,
    };
    try {
      const token = (
        await readFile(process.env.SHORTS_MODERATION_TOKEN_FILE || '', 'utf8')
      ).trim();
      if (token.length < 32) throw new Error('Missing service credential');
      const response = await fetch(`${this.endpoint}/inspect`, {
        method: 'POST',
        body: new Uint8Array(video),
        signal: AbortSignal.timeout(150000),
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) throw new Error('Visual service unavailable');
      const result = await response.json();
      const validScore = (n: unknown) =>
        typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
      const topics = new Set([
        'Art',
        'Nature',
        'Technology',
        'Music',
        'Gaming',
        'Learning',
        'Other',
      ]);
      const validLabels = (labels: unknown) =>
        Array.isArray(labels) &&
        labels.length > 0 &&
        labels.length <= 7 &&
        labels.every(
          (label) => topics.has(label?.topic) && validScore(label?.score),
        );
      if (
        result.sourceSha256 !== base.sourceSha256 ||
        !['no_flags', 'review', 'blocked'].includes(result.status) ||
        result.policy !== 'visual-review-v1' ||
        !/^[a-f0-9]{64}$/.test(result.evidenceHash) ||
        !Array.isArray(result.frames) ||
        result.frames.length < 3 ||
        result.frames.length > 145 ||
        result.frameCount !== result.frames.length ||
        !Number.isFinite(result.duration) ||
        result.duration < 2 ||
        result.duration > 60 ||
        result.frameCount < Math.floor(result.duration * 2) - 1 ||
        typeof result.reason !== 'string' ||
        result.reason.length > 1000 ||
        typeof result.sampling !== 'string' ||
        result.sampling.length > 200 ||
        !validLabels(result.labels) ||
        !['safety', 'topics'].every(
          (name) =>
            typeof result.models?.[name]?.repository === 'string' &&
            /^[a-f0-9]{40}$/.test(result.models?.[name]?.revision || ''),
        ) ||
        !validScore(result.maxNsfwScore) ||
        result.frames.some(
          (f: any) =>
            !validScore(f.nsfwScore) ||
            !/^[a-f0-9]{64}$/.test(f.sha256) ||
            !validLabels(f.labels) ||
            !Number.isFinite(f.at) ||
            f.at < 0 ||
            f.at > result.duration,
        ) ||
        result.humanReviewRequired !== true
      )
        throw new Error('Invalid visual evidence');
      const peak = Math.max(...result.frames.map((f: any) => f.nsfwScore));
      const timestamps = result.frames
        .map((f: any) => f.at)
        .sort((a: number, b: number) => a - b);
      if (
        timestamps[0] > 0.5 ||
        result.duration - timestamps.at(-1) > 0.6 ||
        timestamps.some(
          (at: number, i: number) => i > 0 && at - timestamps[i - 1] > 0.6,
        )
      )
        throw new Error('Incomplete temporal coverage');
      const expected =
        peak >= 0.8 ? 'blocked' : peak >= 0.3 ? 'review' : 'no_flags';
      if (result.status !== expected || result.maxNsfwScore !== peak)
        throw new Error('Invalid safety decision');
      return { ...result, ...base };
    } catch {
      return {
        ...base,
        status: 'error',
        reason:
          'Visual inspection is unavailable or incomplete. Keep this video private and retry the scan.',
      };
    }
  }
}

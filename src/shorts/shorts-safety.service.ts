import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { discardShortsResponse, readShortsJson } from './shorts-upstream';

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

/** Infrastructure backpressure, never a safety verdict about the video. */
export class ShortsModerationUnavailableError extends Error {
  constructor() {
    super('Visual inspection is temporarily unavailable');
    this.name = 'ShortsModerationUnavailableError';
  }
}

@Injectable()
export class ShortsSafetyService implements OnModuleDestroy {
  private readonly shutdown = new AbortController();
  readonly demoAutoApprove =
    process.env.SHORTS_DEMO_AUTO_APPROVE === '1' &&
    process.env.SHORTS_TESTNET_MVP === '1' &&
    process.env.NODE_ENV !== 'production';
  private readonly endpoint =
    process.env.SHORTS_MODERATION_URL || 'http://127.0.0.1:3340';
  constructor() {
    const url = new URL(this.endpoint);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          local &&
          process.env.NODE_ENV !== 'production'
        ))
    ) {
      throw new Error('Moderation requires HTTPS outside local development');
    }
    if (
      process.env.NODE_ENV === 'production' &&
      !isAbsolute(process.env.SHORTS_MODERATION_TOKEN_FILE || '')
    ) {
      throw new Error('Mount the moderation service credential');
    }
  }
  private async readiness(parent?: AbortSignal) {
    if (this.demoAutoApprove) return undefined;
    try {
      const signal = AbortSignal.any([
        this.shutdown.signal,
        AbortSignal.timeout(3000),
        ...(parent ? [parent] : []),
      ]);
      signal.throwIfAborted();
      const response = await fetch(`${this.endpoint}/health`, {
        signal,
        redirect: 'error',
      });
      if (!response.ok) {
        discardShortsResponse(response);
        return undefined;
      }
      return await readShortsJson(response, 16384, signal);
    } catch {
      return undefined;
    }
  }
  async health() {
    return (await this.readiness())?.ready === true;
  }
  async accepting(signal?: AbortSignal) {
    const state = await this.readiness(signal);
    // Older scanner instances omit admission state. A health check is only a
    // hint; inspection still handles 429/503 races through fenced deferral.
    return (
      state?.ready === true &&
      (state.accepting === undefined || state.accepting === true)
    );
  }
  async scan(
    video: Buffer,
    signal?: AbortSignal,
    retryUnavailable = false,
  ): Promise<VisualSafety | undefined> {
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
      const deadline = AbortSignal.any([
        this.shutdown.signal,
        AbortSignal.timeout(150000),
        ...(signal ? [signal] : []),
      ]);
      deadline.throwIfAborted();
      const response = await fetch(`${this.endpoint}/inspect`, {
        method: 'POST',
        redirect: 'error',
        body: new Uint8Array(video),
        signal: deadline,
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: `Bearer ${token}`,
        },
      }).catch(() => {
        throw new ShortsModerationUnavailableError();
      });
      if (!response.ok) {
        discardShortsResponse(response);
        if (
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500
        )
          throw new ShortsModerationUnavailableError();
        throw new Error('Visual service unavailable');
      }
      const result = await readShortsJson(response, 262144, deadline).catch(
        (error) => {
          if (deadline.aborted || error instanceof TypeError)
            throw new ShortsModerationUnavailableError();
          throw error;
        },
      );
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
    } catch (error) {
      if (
        retryUnavailable &&
        error instanceof ShortsModerationUnavailableError &&
        !this.shutdown.signal.aborted &&
        !signal?.aborted
      )
        throw error;
      return {
        ...base,
        status: 'error',
        reason:
          'Visual inspection is unavailable or incomplete. Keep this video private and retry the scan.',
      };
    }
  }
  onModuleDestroy() {
    this.shutdown.abort();
  }
}

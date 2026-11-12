import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HlsPackage, sourceKey } from './hls-protocol/hls-package';
import { PlaybackDescriptor } from './hls-protocol/playback-descriptor';
import {
  shortsStreamConnection,
  shortsStreamKey,
} from './shorts-stream-connection';
import { discardShortsResponse, readShortsJson } from './shorts-upstream';

@Injectable()
export class ShortsHlsReadbackService {
  private readonly connection: ReturnType<typeof shortsStreamConnection>;

  constructor() {
    const flag = process.env.SHORTS_STREAM_VERIFY_HLS ?? 'false';
    if (flag !== 'true' && flag !== 'false')
      throw new Error('Invalid SHORTS_STREAM_VERIFY_HLS');
    if (flag === 'true') {
      this.connection = shortsStreamConnection();
      if (!this.connection)
        throw new Error('HLS readback requires a private streaming endpoint');
    }
  }
  get enabled() {
    return this.connection !== undefined;
  }
  async verify(
    descriptor: PlaybackDescriptor,
    prepared: HlsPackage,
    signal: AbortSignal,
  ) {
    if (
      !this.connection ||
      !descriptor.network ||
      !descriptor.contract ||
      !descriptor.derivatives
    )
      throw new Error('HLS readback identity unavailable');
    const key = await shortsStreamKey(this.connection.keyFile, signal);
    const source = sourceKey(descriptor);
    const challenge = randomBytes(32).toString('hex');
    const response = await fetch(
      `${this.connection.origin}/internal/videos/${encodeURIComponent(descriptor.id)}/verify-prepared`,
      {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          version: 1,
          challenge,
          source,
          cid: prepared.cid,
          generation: descriptor.derivatives.generation.job,
        }),
      },
    );
    if (response.status !== 200) {
      discardShortsResponse(response);
      throw new Error('Prepared media verification unavailable');
    }
    const receipt = await readShortsJson(response, 2048, signal);
    const expected = createHmac('sha256', Buffer.from(key, 'hex'))
      .update(
        JSON.stringify(['shorts-hls-readback-v1', challenge, source, prepared]),
      )
      .digest();
    if (
      receipt?.version !== 1 ||
      receipt.challenge !== challenge ||
      receipt.source !== source ||
      receipt.cid !== prepared.cid ||
      typeof receipt.proof !== 'string' ||
      !/^[0-9a-f]{64}$/.test(receipt.proof) ||
      !timingSafeEqual(Buffer.from(receipt.proof, 'hex'), expected)
    )
      throw new Error('Prepared media verification receipt mismatch');
    signal.throwIfAborted();
  }
}

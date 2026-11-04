import { shortsStorageScope } from './shorts-runtime-scope';
import {
  BadRequestException,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PlaybackEvent } from './shorts-analytics.service';
import { ShortsChainService } from './shorts-chain.service';
import {
  PlaybackDescriptor,
  validateDescriptor,
} from './hls-protocol/playback-descriptor';
import { sourceKey } from './hls-protocol/hls-package';

// Streaming evidence only proves that full segments were authorized. Existing
// elapsed-time, browser/day deduplication and privacy checks still apply.
@Injectable()
export class ShortsPlaybackEvidenceService implements OnModuleInit {
  private key?: Buffer;
  constructor(private readonly chain: ShortsChainService) {}

  async onModuleInit() {
    const file = process.env.SHORTS_STREAM_KEY_FILE;
    if (!file) return;
    const key = (await readFile(file, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new Error('Invalid playback evidence credential');
    this.key = Buffer.from(key, 'hex');
  }

  validate(
    short: { id: string; cid: string },
    event: PlaybackEvent & { proof?: unknown },
    authorizeSource?: (key: string) => Promise<PlaybackDescriptor>,
  ):
    | (PlaybackEvent & { startedAt: number })
    | Promise<PlaybackEvent & { startedAt: number }> {
    if (
      !event ||
      typeof event.id !== 'string' ||
      !/^[a-zA-Z0-9-]{20,80}$/.test(event.id) ||
      typeof event.session !== 'string' ||
      !/^[a-zA-Z0-9-]{20,80}$/.test(event.session) ||
      !Number.isFinite(event.seconds) ||
      event.seconds < 0 ||
      event.seconds > 65 ||
      !['for-you', 'following', 'recent', 'saved', 'shared'].includes(
        event.source,
      )
    )
      throw new BadRequestException('Invalid playback event');
    if (!this.key || !this.chain.state.contract)
      throw new ServiceUnavailableException('Playback measurement unavailable');
    const invalid = () =>
      new UnauthorizedException('Invalid playback evidence');
    if (typeof event.proof !== 'string' || event.proof.length > 2048)
      throw invalid();
    const match = /^m([12])\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(
      event.proof,
    );
    if (!match) throw invalid();
    const signature = createHmac('sha256', this.key)
      .update(`shorts-measurement:v${match[1]}\0${match[2]}`)
      .digest();
    if (!timingSafeEqual(signature, Buffer.from(match[3], 'base64url')))
      throw invalid();
    let value: any;
    try {
      value = JSON.parse(Buffer.from(match[2], 'base64url').toString('utf8'));
    } catch {
      throw invalid();
    }
    const now = Date.now();
    const scope = shortsStorageScope(this.chain);
    if (
      !value ||
      Array.isArray(value) ||
      value.v !== Number(match[1]) ||
      value.id !== short.id ||
      (value.v === 1 && value.cid !== short.cid) ||
      (value.v === 2 &&
        (typeof value.sourceKey !== 'string' ||
          !/^[a-f0-9]{64}$/.test(value.sourceKey))) ||
      value.network !== scope.network ||
      value.contract !== scope.contract ||
      typeof value.nonce !== 'string' ||
      !/^[a-f0-9]{32}$/.test(value.nonce) ||
      typeof value.viewer !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.viewer) ||
      ![
        value.startedAt,
        value.issuedAt,
        value.expiresAt,
        value.admittedMs,
      ].every(Number.isSafeInteger) ||
      value.startedAt < 0 ||
      value.issuedAt < value.startedAt ||
      value.issuedAt > now + 2000 ||
      value.expiresAt <= now ||
      value.expiresAt <= value.issuedAt ||
      value.expiresAt - value.startedAt > 125000 ||
      value.admittedMs < 0 ||
      value.admittedMs > 61000
    )
      throw invalid();
    const viewer = createHash('sha256')
      .update(
        `shorts-viewer:v1\n${value.nonce}\n${createHash('sha256').update(event.session).digest('hex')}`,
      )
      .digest('hex');
    if (viewer !== value.viewer) throw invalid();
    // Authenticate and validate the browser/time bounds before any source lookup.
    // A source CID may differ from a legacy post's immutable published CID.
    if (value.v === 2) {
      if (!authorizeSource) throw invalid();
      return authorizeSource(value.sourceKey).then((descriptor) => {
        try {
          validateDescriptor(descriptor, short.id);
          if (
            descriptor.cid !== value.cid ||
            descriptor.network !== scope.network ||
            descriptor.contract !== scope.contract ||
            sourceKey(descriptor) !== value.sourceKey ||
            value.expiresAt <= Date.now()
          )
            throw invalid();
        } catch {
          throw invalid();
        }
        return this.measuredEvent(value, event);
      });
    }
    return this.measuredEvent(value, event);
  }
  private measuredEvent(value: any, event: PlaybackEvent) {
    // Do not persist the receipt, nonce, token or public browser identifier.
    return {
      startedAt: value.startedAt,
      id: event.id,
      session: event.session,
      source: event.source,
      seconds: Math.min(
        event.seconds,
        value.admittedMs / 1000,
        (value.issuedAt - value.startedAt) / 1000 + 0.5,
      ),
    };
  }
}

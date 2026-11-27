import type { ShortRecord } from './shorts.types';
import type { PlaybackDescriptor } from './hls-protocol/playback-descriptor';
import { validateOriginalContent } from './shorts-original-content';

/** A public wire descriptor: no private object locations, review evidence or credentials. */
export function shortsPlaybackDescriptor(
  short: ShortRecord,
  scope: Pick<PlaybackDescriptor, 'network' | 'contract'>,
): PlaybackDescriptor {
  validateOriginalContent(short);
  return {
    id: short.id,
    cid: short.cid,
    ...scope,
    bytes: short.bytes,
    original: {
      version: short.original.version,
      sha256: short.original.sha256,
      mediaType: short.original.mediaType,
      importProfile: short.original.importProfile,
    },
    derivatives: {
      version: short.derivatives.version,
      cid: short.derivatives.cid,
      assetsCid: short.derivatives.assetsCid,
      profile: short.derivatives.profile,
      fingerprint: short.derivatives.fingerprint,
      generation: {
        job: short.derivatives.generation.job,
        fence: short.derivatives.generation.fence,
      },
      videos: short.derivatives.videos.map(
        ({ name, width, height, frameRate }) => ({
          name,
          width,
          height,
          frameRate,
        }),
      ),
    },
    files: short.files.map(({ name, bytes, sha256 }) => ({
      name,
      bytes,
      sha256,
    })),
  };
}
